/**
 * sheetRoutes.js  (SERVER-ONLY)
 *
 * KV-backed overrides for Google Sheet targets, layered on top of the
 * hardcoded defaults in _shared/routing.js (BRANDS[brandId].sheetId,
 * SHEET_LAYOUT[moduleId].tab, PROMOTION_SHEET_CONFIG) and
 * _shared/promoCodeSheet default below — same "KV override, code default
 * underneath" pattern as _shared/routes.js (Telegram routing). This is
 * what lets a SuperAdmin change WHICH sheet/tab a topic writes to, live
 * from the browser (the "Integrations" admin page), instead of needing a
 * code edit + redeploy.
 *
 * IMPORTANT — SCOPE: this only overrides the destination (sheetId + tab
 * name). Column structure/order (which fields go in which column) stays
 * hardcoded in SHEET_LAYOUT/PROMOTION_SHEET_CONFIG — swapping a topic to
 * a brand-new sheet still requires that sheet's tab to have the same
 * column layout the code expects, or writes will land in the wrong
 * columns. This is deliberate: column layout changes need a code review
 * (they can silently corrupt data if wrong), destination doesn't.
 *
 * Two independent groups, two key shapes:
 *
 *   Issue submission sheet — one row per brand+module, mirrors
 *   route:<brandId>:<moduleId> exactly:
 *     sheet:<brandId>:<moduleId>  ->  { sheetId, tab }
 *
 *   Promo code sheet — NOT brand-specific (one shared workbook searched
 *   across every team's tab, regardless of which brand the agent has
 *   selected on the page) — a single key, no brand/module dimension.
 *   Unlike the Issue Submission Gsheet's single `tab`, this one searches
 *   MULTIPLE tabs at once (11 team tabs today), so `tabs` is an array:
 *     sheet:promoCode  ->  { sheetId, tabs: [...] }
 *
 * Stored in the same THREADS_KV namespace as accounts/offices/routes,
 * under its own key prefix so nothing collides.
 */

function sheetKey(brandId, moduleId) {
  return `sheet:${brandId}:${moduleId}`;
}

const PROMO_CODE_KEY = "sheet:promoCode";

// Both save entry points accept "Google Sheet URL or ID" per their
// placeholder text — but a raw Sheets URL
// (https://docs.google.com/spreadsheets/d/<ID>/edit?gid=0) is NOT a
// valid sheetId on its own; the Sheets API only wants the <ID> segment.
// Pasting the full URL used to get stored verbatim and produce a
// malformed API request (a URL glued onto the end of another URL),
// which 404s — this extracts the real ID either way, so the input
// genuinely accepts both forms like the placeholder promises.
function extractSheetId(input) {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

function parseSheetTarget(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId) return null; // guard against a malformed/emptied entry
    return { sheetId: String(parsed.sheetId), tab: parsed.tab ? String(parsed.tab) : "" };
  } catch {
    return null;
  }
}

function parsePromoCodeTarget(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId) return null;
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.map((t) => String(t).trim()).filter(Boolean) : [];
    return { sheetId: String(parsed.sheetId), tabs };
  } catch {
    return null;
  }
}

// ---- Issue submission sheet (per brand + module) ----

// Used at submission/edit/lookup time (submit.js, forward.js,
// check-tid.js, threads/[id].js) — a single KV read, null if nothing
// overridden for this brand+module (caller falls back to the hardcoded
// SHEET_LAYOUT/routing.js default).
export async function getSheetOverride(env, brandId, moduleId) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(sheetKey(brandId, moduleId));
  return parseSheetTarget(raw);
}

// Fetches every brand x module override in one batch — used by the admin
// GET endpoint to render the full grid, same batching approach as
// getAllRouteOverrides() in routes.js.
export async function getAllSheetOverrides(env, brandIds, moduleIds) {
  if (!env.THREADS_KV) return {};
  const pairs = [];
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) pairs.push([brandId, moduleId]);
  }
  const raws = await Promise.all(pairs.map(([b, m]) => env.THREADS_KV.get(sheetKey(b, m))));
  const result = {};
  pairs.forEach(([brandId, moduleId], i) => {
    const parsed = parseSheetTarget(raws[i]);
    if (parsed) result[`${brandId}|${moduleId}`] = parsed;
  });
  return result;
}

export async function saveSheetOverride(env, brandId, moduleId, { sheetId, tab }) {
  const trimmedSheetId = extractSheetId(sheetId);
  if (!trimmedSheetId) throw new Error("Sheet ID is required.");
  const value = { sheetId: trimmedSheetId, tab: String(tab || "").trim() };
  await env.THREADS_KV.put(sheetKey(brandId, moduleId), JSON.stringify(value));
  return value;
}

export async function deleteSheetOverride(env, brandId, moduleId) {
  await env.THREADS_KV.delete(sheetKey(brandId, moduleId));
}

// Combines a KV override with the hardcoded default in one call — the
// shape every real call site (submit.js, forward.js, check-tid.js,
// threads/[id].js) actually wants: "give me the sheetId+tab to use RIGHT
// NOW for this brand+module", already resolved, caller doesn't need to
// know or care whether it came from KV or code.
export async function resolveSheetTarget(env, brandId, moduleId, defaultSheetId, defaultTab) {
  const override = await getSheetOverride(env, brandId, moduleId);
  if (override) return { sheetId: override.sheetId, tab: override.tab || defaultTab, isOverride: true };
  return { sheetId: defaultSheetId, tab: defaultTab, isOverride: false };
}

// Combines the KV override with the hardcoded default in one call, same
// shape as resolveSheetTarget() above — caller (promo-search.js) doesn't
// need to know or care whether sheetId/tabs came from KV or code. `tabs`
// is all-or-nothing: an override either replaces the entire tab list, or
// (if `tabs` was left empty when saving) falls back to the code default
// list — there's no per-tab merge, since a partial list would silently
// stop searching some teams' data with no visible warning.
export async function resolvePromoCodeTarget(env, defaultSheetId, defaultTabs) {
  const override = await getPromoCodeSheetOverride(env);
  if (override) return { sheetId: override.sheetId, tabs: override.tabs.length ? override.tabs : defaultTabs, isOverride: true };
  return { sheetId: defaultSheetId, tabs: defaultTabs, isOverride: false };
}

export async function getPromoCodeSheetOverride(env) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(PROMO_CODE_KEY);
  return parsePromoCodeTarget(raw);
}

export async function savePromoCodeSheetOverride(env, { sheetId, tabs }) {
  const trimmedSheetId = extractSheetId(sheetId);
  if (!trimmedSheetId) throw new Error("Sheet ID is required.");
  const cleanTabs = Array.isArray(tabs) ? tabs.map((t) => String(t).trim()).filter(Boolean) : [];
  const value = { sheetId: trimmedSheetId, tabs: cleanTabs };
  await env.THREADS_KV.put(PROMO_CODE_KEY, JSON.stringify(value));
  return value;
}

export async function deletePromoCodeSheetOverride(env) {
  await env.THREADS_KV.delete(PROMO_CODE_KEY);
}
