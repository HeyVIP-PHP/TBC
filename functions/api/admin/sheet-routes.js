/**
 * /api/admin/sheet-routes   (part of the Integration Portal admin pages,
 * alongside the existing /api/admin/routes.js which stays untouched)
 *
 * Two independent resources, same request shape as /api/admin/routes.js
 * (mirrors it deliberately — same KV-override pattern, same auth model),
 * but gated by two SEPARATE section ids now (2026-08 split, see
 * _shared/accounts.js's comment on ADMIN_SECTIONS) since they're two
 * different screens in the UI (public/index.html's "issuesheet" and
 * "promosheet" Agent Profile-gated modals) that just happen to share one
 * endpoint:
 *
 *   GET
 *     -> { ok, brands, modules, sheets?, promoCode? }
 *        sheets["<brandId>|<moduleId>"] = { sheetId, tab, isOverride }
 *        promoCode = { sheetId, isOverride }  (not brand-specific)
 *     `sheets` is only included if the caller has "issueSubmissionSheet";
 *     `promoCode` only if they have "promoCodeSheet" — a caller with just
 *     one of the two still gets a 200 with only their half populated,
 *     not a 403; the two frontend loaders (loadIssueSheetRoutes() /
 *     loadPromoCodeSheet() in index.html) only ever read their own half
 *     anyway, since each is a stand-alone screen. Only a 403 if NEITHER
 *     is granted — SuperAdmin and above see both automatically (see
 *     canSeeAdminSection()'s rank-floor exception in _shared/accounts.js),
 *     every other rank needs at least one Owner-opt-in.
 *
 *   POST { action:"save", brandId, moduleId, sheetId, tab } -> store an
 *     Issue Submission Gsheet override. Takes effect on the very next
 *     submission/edit/lookup for that brand+module — no redeploy needed.
 *     Requires "issueSubmissionSheet". No separate View/Edit split on
 *     this id (see EDITABLE_ADMIN_SECTIONS in _shared/accounts.js) —
 *     being able to see this screen at all already means being trusted
 *     to change it, same as GET requires only that one id too.
 *   POST { action:"reset", brandId, moduleId } -> delete that override,
 *     reverting to the hardcoded default. Same "issueSubmissionSheet"
 *     gate as save.
 *   POST { action:"savePromoCode", sheetId, tabs } -> store the Promo Code
 *     Gsheet override (single, no brandId/moduleId — see
 *     _shared/sheetRoutes.js for why this one isn't brand-specific).
 *     `tabs` is an array of team tab names to search across (replaces the
 *     hardcoded 11-tab list in promo-search.js wholesale — see that
 *     file's PROMO_CODE_SHEET.tabs for the default). Requires
 *     "promoCodeSheet" — independent of "issueSubmissionSheet" above, an
 *     account can have either, both, or neither.
 *   POST { action:"resetPromoCode" } -> delete it, reverting to the
 *     hardcoded default in promo-search.js. Same "promoCodeSheet" gate.
 *
 * SCOPE NOTE: this only ever changes WHICH sheet/tab a topic writes to.
 * Column structure (which field lands in which column) is not editable
 * here and stays hardcoded in _shared/routing.js's SHEET_LAYOUT /
 * PROMOTION_SHEET_CONFIG — see the header of _shared/sheetRoutes.js for
 * why that split is deliberate.
 *
 * PROMOTION REQUEST — special-cased same as it is everywhere else in the
 * codebase: routing.js's PROMOTION_SHEET_CONFIG is keyed by
 * "<brandId>|<promotion name>", not just brandId, because different
 * promotions COULD in principle use different sheets. In practice every
 * promotion for a given brand shares one sheet+tab today (see the
 * comment in routing.js), so this admin page treats "promotion_request"
 * as ONE row per brand, same as every other module — the override
 * applies to every promotion type under that brand uniformly. If a brand
 * ever needs per-promotion sheet targets, this'll need a finer key than
 * sheet:<brandId>:promotion_request; not needed today.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection } from "../../_shared/accounts.js";
import {
  getAllSheetOverrides, saveSheetOverride, deleteSheetOverride,
  getPromoCodeSheetOverride, savePromoCodeSheetOverride, deletePromoCodeSheetOverride,
} from "../../_shared/sheetRoutes.js";
import { BRANDS, MODULE_META, SHEET_LAYOUT, PROMOTION_SHEET_CONFIG } from "../../_shared/routing.js";

// Same default sheetId + tab list promo-search.js falls back to when
// nothing's been saved through this page yet — kept in sync manually
// (small, rarely-changed list; not worth importing across files for).
const PROMO_CODE_DEFAULT_SHEET_ID = "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98";
const PROMO_CODE_DEFAULT_TABS = [
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
];

// The 9 real submission topics that log to a Sheet at all — same list
// RECORD_TO_SHEET in routing.js flags true for. Deposit Request's
// per-channel pseudo-modules (deposit_copopay etc.) are Telegram-routing
// only, never a Sheet target of their own — every channel still logs
// under the single "deposit_request" row.
const ISSUE_MODULES = ["deposit_request", "qa", "account_issue", "bank_issue", "withdraw_issue", "risk_issue", "promotion_request", "daily_report", "genie_issue"];

// promotion_request has no entry in SHEET_LAYOUT (it uses
// PROMOTION_SHEET_CONFIG instead — see file header) — this pulls that
// brand's shared sheetId+tab out of the first matching config entry,
// since every promotion type for a brand uses the same one today.
function promotionDefaultFor(brandId) {
  const entry = Object.entries(PROMOTION_SHEET_CONFIG).find(([key]) => key.startsWith(`${brandId}|`));
  return entry ? { sheetId: entry[1].sheetId, tab: entry[1].tab } : { sheetId: "", tab: "" };
}

function defaultFor(brandId, moduleId) {
  if (moduleId === "promotion_request") return promotionDefaultFor(brandId);
  const layout = SHEET_LAYOUT[moduleId];
  return { sheetId: BRANDS[brandId]?.sheetId || "", tab: layout?.tab || "" };
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  const canSheets = canSeeAdminSection(auth.account, "issueSubmissionSheet");
  const canPromo = canSeeAdminSection(auth.account, "promoCodeSheet");
  if (!canSheets && !canPromo) return json({ ok: false, error: "You don't have access to Issue Submission Gsheet or Promo Code Gsheet." }, 403);

  const brandIds = Object.keys(BRANDS);
  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  const modules = ISSUE_MODULES.map((id) => ({ id, name: MODULE_META[id].name, emoji: MODULE_META[id].emoji }));
  const result = { ok: true, brands, modules };

  // Each half is only computed and attached if this caller actually has
  // that specific id — a caller with only "promoCodeSheet" (say) never
  // even triggers the sheets KV reads, and never sees `sheets` in the
  // response at all (not just an empty object) — see the file header
  // for why a partial 200 is correct here instead of a 403.
  if (canSheets) {
    const overrides = await getAllSheetOverrides(env, brandIds, ISSUE_MODULES);
    const sheets = {};
    for (const brandId of brandIds) {
      for (const moduleId of ISSUE_MODULES) {
        const key = `${brandId}|${moduleId}`;
        const override = overrides[key];
        if (override) {
          sheets[key] = { sheetId: override.sheetId, tab: override.tab, isOverride: true };
        } else {
          const fallback = defaultFor(brandId, moduleId);
          sheets[key] = { sheetId: fallback.sheetId, tab: fallback.tab, isOverride: false };
        }
      }
    }
    result.sheets = sheets;
  }

  if (canPromo) {
    const promoOverride = await getPromoCodeSheetOverride(env);
    result.promoCode = promoOverride
      ? { sheetId: promoOverride.sheetId, tabs: promoOverride.tabs, isOverride: true }
      : { sheetId: PROMO_CODE_DEFAULT_SHEET_ID, tabs: PROMO_CODE_DEFAULT_TABS, isOverride: false };
  }

  return json(result);
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "savePromoCode" || body.action === "resetPromoCode") {
    if (!canSeeAdminSection(auth.account, "promoCodeSheet")) return json({ ok: false, error: "You don't have access to Promo Code Gsheet." }, 403);
  } else if (body.action === "save" || body.action === "reset") {
    if (!canSeeAdminSection(auth.account, "issueSubmissionSheet")) return json({ ok: false, error: "You don't have access to Issue Submission Gsheet." }, 403);
  } else {
    return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
  }

  if (body.action === "savePromoCode") {
    try {
      const saved = await savePromoCodeSheetOverride(env, { sheetId: body.sheetId, tabs: body.tabs });
      return json({ ok: true, promoCode: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "resetPromoCode") {
    await deletePromoCodeSheetOverride(env);
    return json({ ok: true, promoCode: { sheetId: PROMO_CODE_DEFAULT_SHEET_ID, tabs: PROMO_CODE_DEFAULT_TABS, isOverride: false } });
  }

  const { brandId, moduleId } = body || {};
  if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  if (!ISSUE_MODULES.includes(moduleId)) return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);

  if (body.action === "save") {
    try {
      const saved = await saveSheetOverride(env, brandId, moduleId, { sheetId: body.sheetId, tab: body.tab });
      return json({ ok: true, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteSheetOverride(env, brandId, moduleId);
    const fallback = defaultFor(brandId, moduleId);
    return json({ ok: true, sheet: { sheetId: fallback.sheetId, tab: fallback.tab, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
