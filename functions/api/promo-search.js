/**
 * GET /api/promo-search?codes=CODE1,CODE2
 *
 * Search-only — never writes anything. Reads directly from the shared
 * Promo Code Google Sheet (one workbook, many team tabs) and returns
 * every match of the Promo Code column (contains/partial match, not
 * exact — e.g. searching "1500" matches "1500PKR"), grouped by tab, so
 * the dashboard can show "which team's sheet has this code" the same
 * way the reference screenshot did.
 *
 * Requires the sheet to be shared (Viewer is enough) with the service
 * account: reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com
 *
 * Column layout (same across all tabs below, columns A-N, header in row 1,
 * data starts row 2):
 *   A Brand | B Bonus Code | C Promo Code | D Deposit Range | E Bonus % |
 *   F Per Spin Value | G Max Bonus | H Wager | I Max Withdraw |
 *   J Expired Day | K Products | L Excluded Products/GAMES |
 *   M Under Group/Affiliate/VIP Level | N Expired On
 *
 * "Start On" has no source column yet in this sheet — always returned as
 * "" until one exists; the frontend shows it as a dash.
 */
import { batchGetValues, getSheetTabTitles } from "../_shared/googleSheets.js";
import { verifyRequest } from "../_shared/accounts.js";

const PROMO_CODE_SHEET = {
  sheetId: "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98",
  range: "A2:N1000",
  tabs: [
    "Welcome Call Team",
    "Retention team (Outsource)",
    "Retention Team (BDT)",
    "Retention Team (PKR)",
    "Retention Team (INR)",
    "Retention Team (PHP)",
    "Retention Team FT & TIRESIAS (BDT)",
    "Retention Team (VND)",
    "Retention Team (NPR)",
    "LIVE Streaming",
    "FB Ads (BDT)",
  ],
};

function sheetEditUrl() {
  return `https://docs.google.com/spreadsheets/d/${PROMO_CODE_SHEET.sheetId}/edit`;
}

// Real tab titles rarely change, so cache them for a few minutes per Worker
// isolate instead of re-fetching metadata on every single search.
let cachedTabTitles = null; // { titles, expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env) {
  const now = Date.now();
  if (cachedTabTitles && cachedTabTitles.expiresAt > now) return cachedTabTitles.titles;
  const titles = await getSheetTabTitles(env, PROMO_CODE_SHEET.sheetId);
  cachedTabTitles = { titles, expiresAt: now + TAB_CACHE_MS };
  return titles;
}

// Normalizes a tab name for comparison so invisible differences — non-
// breaking spaces, double spaces, fullwidth punctuation, stray
// leading/trailing whitespace — don't cause a false "missing tab" even
// when the name looks identical to the human eye. NFKC folds fullwidth
// parentheses etc. into their plain-ASCII equivalents; \s in JS already
// matches the non-breaking space character.
function normalizeTabName(name) {
  return String(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function onRequestGet(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  // Whole hub requires login now — see submit.js for the same note.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // No search yet (e.g. the page's initial load, just to fetch sheetUrl
  // for the "Open Sheet" button) — nothing to look up.
  if (!codes.length) {
    return json({ ok: true, groups: [], sheetUrl: sheetEditUrl() });
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return json({ ok: false, error: "Server is missing Google service account credentials." }, 500);
  }

  const needles = codes.map((c) => c.toUpperCase());

  // Google's batchGet is all-or-nothing: a single mistyped/renamed/deleted
  // tab name 400s the ENTIRE request. So resolve which configured tabs
  // actually exist on the live sheet first, and only ever ask for those —
  // a missing tab becomes a warning in the response, not a hard failure.
  let realTitles;
  try {
    realTitles = await resolveExistingTabs(env);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
  // Map normalized -> the sheet's actual title string, so once matched we
  // query Google using the REAL title (not our possibly-slightly-off
  // config string) — avoids a second, subtler mismatch at the API call.
  const realByNormalized = new Map(realTitles.map((t) => [normalizeTabName(t), t]));

  const tabsToQuery = []; // { configured, real }
  const missingTabs = [];
  for (const configured of PROMO_CODE_SHEET.tabs) {
    const real = realByNormalized.get(normalizeTabName(configured));
    if (real) tabsToQuery.push({ configured, real });
    else missingTabs.push(configured);
  }

  let valueRanges = [];
  if (tabsToQuery.length) {
    try {
      const ranges = tabsToQuery.map(({ real }) => `'${real.replace(/'/g, "''")}'!${PROMO_CODE_SHEET.range}`);
      valueRanges = await batchGetValues(env, PROMO_CODE_SHEET.sheetId, ranges);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }
  }

  const groups = [];
  tabsToQuery.forEach(({ real }, i) => {
    const rows = (valueRanges[i] && valueRanges[i].values) || [];
    const matches = [];
    for (const row of rows) {
      const promoCode = (row[2] || "").trim();
      if (!promoCode) continue;
      const upperCode = promoCode.toUpperCase();
      // Contains match, not exact — e.g. searching "1500" should surface
      // "1500PKR". Any one of the comma-separated search terms being a
      // substring of the code counts as a hit.
      if (!needles.some((n) => upperCode.includes(n))) continue;
      matches.push({
        brand: row[0] || "",
        bonusCode: row[1] || "",
        promoCode,
        depositRange: row[3] || "",
        maxBonus: row[6] || "",
        wager: row[7] || "",
        maxWithdraw: row[8] || "",
        expiredDay: row[9] || "",
        products: row[10] || "",
        excluded: row[11] || "",
        groupVip: row[12] || "",
        startOn: "", // no source column yet — see file header
        expiredOn: row[13] || "",
      });
    }
    if (matches.length) groups.push({ tab: real, count: matches.length, matches });
  });

  return json({
    ok: true,
    groups,
    sheetUrl: sheetEditUrl(),
    missingTabs: missingTabs.length ? missingTabs : undefined,
    // Only included when something's missing — lets whoever's debugging
    // this see the sheet's real tab names side-by-side with what's
    // configured, without having to open the sheet.
    actualSheetTabs: missingTabs.length ? realTitles : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
