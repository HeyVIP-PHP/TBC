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
 * COLUMN MAPPING (fixed 2026-08-18): no longer a hardcoded column-letter
 * assumption. An earlier version guessed fixed indices (assumed a "Per
 * Spin Value" column that didn't actually exist), which silently shifted
 * every field one column to the right (Max Bonus showed Wager's value,
 * Wager showed Max Withdraw's value, etc) — confirmed against the live
 * sheet and a reference screenshot.
 *
 * Instead, row 1 of EACH tab is read as a real header row and matched
 * by header TEXT (via HEADER_PATTERNS/buildColumnMap() below) to figure
 * out which column each field actually lives in on that specific tab —
 * so a column being reordered, inserted, or differing between tabs no
 * longer silently misaligns the data. If a tab's header doesn't contain
 * a recognizable label for some field, that field falls back to the
 * DEFAULT_COLUMNS index documented next to it and the tab is reported
 * back in `headerWarnings` so it's visible instead of silently wrong.
 *
 * "Start On" has no source column in any tab yet — always returned as
 * "" until one exists; the frontend shows it as a dash.
 */
import { batchGetValues, getSheetTabTitles } from "../_shared/googleSheets.js";
import { verifyRequest } from "../_shared/accounts.js";
import { getFeatureStatus, accountCanBypass } from "../_shared/featureStatus.js";
import { resolvePromoCodeTarget } from "../_shared/sheetRoutes.js";

// Default sheetId + tab list — overridable live from the Integrations
// admin page ("Promo code Gsheet" row, not brand-specific — see the
// header of _shared/sheetRoutes.js for why). resolvePromoCodeTarget()
// checks the KV override first (sheetId AND tabs travel together — an
// override either replaces both or neither) and falls back to these
// constants, same layering as every other sheet target in this codebase.
const PROMO_CODE_SHEET = {
  sheetId: "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98",
  // Starts at row 1 (not 2) on purpose now — row 1 is read as the real
  // header and used to locate columns by name; see buildColumnMap() below.
  range: "A1:N1000",
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

function sheetEditUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

// Fallback indices — only used for a field on a tab whose header row
// doesn't contain a recognizable label for it (missing/renamed header,
// blank cell, etc). Matches the real layout as of the 2026-08-18 fix;
// kept only as a safety net, not the primary source of truth anymore.
const DEFAULT_COLUMNS = {
  brand: 0,
  bonusCode: 1,
  promoCode: 2,
  depositRange: 3,
  maxBonus: 5,
  wager: 6,
  maxWithdraw: 7,
  expiredDay: 8,
  products: 9,
  excluded: 10,
  groupVip: 11,
  startOn: undefined, // no source column anywhere yet
  expiredOn: 12,
};

// Ordered list — first pattern that matches a normalized header cell
// wins. Order matters: more specific patterns (e.g. "bonuscode") must be
// checked before looser ones that could also match part of them.
const HEADER_PATTERNS = [
  ["promoCode", /promo\s*code/],
  ["bonusCode", /bonus\s*code/],
  ["brand", /^brands?$/],
  ["depositRange", /deposit\s*range/],
  ["maxBonus", /max\s*bonus/],
  ["wager", /wager/],
  ["maxWithdraw", /max\s*withdraw/],
  ["expiredDay", /expired\s*day/],
  ["expiredOn", /expired\s*on/],
  ["startOn", /start\s*on/],
  ["products", /^products?$/],
  ["excluded", /excluded/],
  ["groupVip", /(group|vip|affiliate)/],
];

function normalizeHeaderCell(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

// Reads one tab's actual header row and returns { field: columnIndex }
// for every field it recognizes. Fields it can't find a header for are
// simply absent from the map — callers fall back to DEFAULT_COLUMNS.
function buildColumnMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((cell, i) => {
    const norm = normalizeHeaderCell(cell);
    if (!norm) return;
    for (const [field, pattern] of HEADER_PATTERNS) {
      if (map[field] !== undefined) continue; // first match per field wins
      if (pattern.test(norm)) {
        map[field] = i;
        break;
      }
    }
  });
  return map;
}

// col(map, field, row) — reads a field's value out of a data row, using
// the tab's own detected column index when available, DEFAULT_COLUMNS
// otherwise.
function col(map, field, row) {
  const idx = map[field] !== undefined ? map[field] : DEFAULT_COLUMNS[field];
  if (idx === undefined) return "";
  return row[idx] || "";
}

// Real tab titles rarely change, so cache them for a few minutes per Worker
// isolate instead of re-fetching metadata on every single search. Keyed
// by sheetId (not a single flat cache) so switching the Integrations
// override to a different sheet doesn't briefly keep serving the OLD
// sheet's tab list for up to 5 minutes.
let cachedTabTitles = {}; // { [sheetId]: { titles, expiresAt } }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env, sheetId) {
  const now = Date.now();
  const cached = cachedTabTitles[sheetId];
  if (cached && cached.expiresAt > now) return cached.titles;
  const titles = await getSheetTabTitles(env, sheetId);
  cachedTabTitles[sheetId] = { titles, expiresAt: now + TAB_CACHE_MS };
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

  // Settings (Maintenance / Coming soon) — see the matching comment in
  // submit.js. Real enforcement, not just index.html graying the card
  // out and promo.html blocking on load.
  const featureStatus = await getFeatureStatus(env, "promo_code_search");
  if (featureStatus.status !== "active" && !accountCanBypass(account, featureStatus.bypassRoles)) {
    return json({ ok: false, error: "Promo Code Search is currently unavailable. Please try again later." }, 403);
  }

  // Integrations admin page override ("Promo code Gsheet" row) takes
  // priority over the hardcoded default — see _shared/sheetRoutes.js.
  // Not brand-specific, so this is one lookup, not per-brand.
  const target = await resolvePromoCodeTarget(env, PROMO_CODE_SHEET.sheetId, PROMO_CODE_SHEET.tabs);
  const sheetId = target.sheetId;

  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // No search yet (e.g. the page's initial load, just to fetch sheetUrl
  // for the "Open Sheet" button) — nothing to look up.
  if (!codes.length) {
    return json({ ok: true, groups: [], sheetUrl: sheetEditUrl(sheetId) });
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
    realTitles = await resolveExistingTabs(env, sheetId);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
  // Map normalized -> the sheet's actual title string, so once matched we
  // query Google using the REAL title (not our possibly-slightly-off
  // config string) — avoids a second, subtler mismatch at the API call.
  const realByNormalized = new Map(realTitles.map((t) => [normalizeTabName(t), t]));

  const tabsToQuery = []; // { configured, real }
  const missingTabs = [];
  for (const configured of target.tabs) {
    const real = realByNormalized.get(normalizeTabName(configured));
    if (real) tabsToQuery.push({ configured, real });
    else missingTabs.push(configured);
  }

  let valueRanges = [];
  if (tabsToQuery.length) {
    try {
      const ranges = tabsToQuery.map(({ real }) => `'${real.replace(/'/g, "''")}'!${PROMO_CODE_SHEET.range}`);
      valueRanges = await batchGetValues(env, sheetId, ranges);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }
  }

  const groups = [];
  const headerWarnings = []; // { tab, fields } — fields whose header wasn't found, fell back to default
  const REQUIRED_FIELDS = Object.keys(DEFAULT_COLUMNS).filter((f) => f !== "startOn");

  tabsToQuery.forEach(({ real }, i) => {
    const allRows = (valueRanges[i] && valueRanges[i].values) || [];
    const [headerRow, ...rows] = allRows;
    const colMap = buildColumnMap(headerRow);

    const missingFields = REQUIRED_FIELDS.filter((f) => colMap[f] === undefined);
    if (missingFields.length) headerWarnings.push({ tab: real, fields: missingFields });

    const promoIdx = colMap.promoCode !== undefined ? colMap.promoCode : DEFAULT_COLUMNS.promoCode;

    const matches = [];
    for (const row of rows) {
      const promoCode = (row[promoIdx] || "").trim();
      if (!promoCode) continue;
      const upperCode = promoCode.toUpperCase();
      // Contains match, not exact — e.g. searching "1500" should surface
      // "1500PKR". Any one of the comma-separated search terms being a
      // substring of the code counts as a hit.
      if (!needles.some((n) => upperCode.includes(n))) continue;
      matches.push({
        brand: col(colMap, "brand", row),
        bonusCode: col(colMap, "bonusCode", row),
        promoCode,
        depositRange: col(colMap, "depositRange", row),
        maxBonus: col(colMap, "maxBonus", row),
        wager: col(colMap, "wager", row),
        maxWithdraw: col(colMap, "maxWithdraw", row),
        expiredDay: col(colMap, "expiredDay", row),
        products: col(colMap, "products", row),
        excluded: col(colMap, "excluded", row),
        groupVip: col(colMap, "groupVip", row),
        startOn: col(colMap, "startOn", row), // "" unless a tab ever adds this column
        expiredOn: col(colMap, "expiredOn", row),
      });
    }
    if (matches.length) groups.push({ tab: real, count: matches.length, matches });
  });

  return json({
    ok: true,
    groups,
    sheetUrl: sheetEditUrl(sheetId),
    missingTabs: missingTabs.length ? missingTabs : undefined,
    // Only included when something's missing — lets whoever's debugging
    // this see the sheet's real tab names side-by-side with what's
    // configured, without having to open the sheet.
    actualSheetTabs: missingTabs.length ? realTitles : undefined,
    // Only included when a queried tab's header row didn't have a
    // recognizable label for one or more fields (that field fell back to
    // DEFAULT_COLUMNS) — surfaces a silent misalignment instead of
    // hiding it, without failing the whole search.
    headerWarnings: headerWarnings.length ? headerWarnings : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
