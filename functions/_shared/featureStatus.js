/**
 * featureStatus.js  (SERVER-ONLY)
 *
 * Lets a SuperAdmin/Owner flip any of the hub's clickable entry points to
 * "Maintenance" or "Coming soon" — e.g. while a topic's Telegram routing
 * is mid-change, or a feature isn't ready yet — WITHOUT touching who can
 * see it (that's still account.allowedModules/allowedAdminSections,
 * completely separate). This is a live on/off switch on top of that,
 * same "KV override, code default underneath" layering as routes.js.
 *
 * Controllable items — the 9 real topics (module ids, matching
 * MODULE_META in routing.js — deposit_request's per-channel pseudo-
 * modules are routing-only, not separately controllable here) plus 2
 * fixed pseudo-ids for the two non-topic hub features:
 *   tg_reply_threads   -> /threads.html + /api/threads*
 *   promo_code_search  -> /promo.html + /api/promo-search
 *
 * KV shape:
 *   feature-status:<itemId>  ->  { status: "maintenance"|"coming_soon", bypassRoles: ["superadmin","owner"] }
 * Missing key = "active" (the default, nothing blocked) — turning this
 * on with an empty KV changes nothing that already works, same guarantee
 * every other KV-override feature in this project makes.
 *
 * BYPASS ROLES — 2026-08-01: this used to be a single "bypassRank"
 * threshold (e.g. "superadmin" meaning "superadmin and everything above
 * it"). Replaced with an explicit ARRAY of specific roles allowed
 * through, per business-owner request — e.g. an Owner can now grant
 * "admin" bypass on one item without also having to grant it to
 * superadmin/owner as a side effect of "at least this rank", and can
 * pick any combination (not necessarily contiguous in ROLE_RANK order).
 * Stored as role name strings from _shared/accounts.js's ROLE_RANK.
 */
import { ROLE_RANK } from "./accounts.js";

export const FEATURE_STATUS_ITEMS = [
  { id: "qa", emoji: "🔐", name: "QA" },
  { id: "account_issue", emoji: "🔑", name: "Account Issue" },
  { id: "bank_issue", emoji: "🏦", name: "Bank Issue" },
  { id: "withdraw_issue", emoji: "💸", name: "Withdraw Issue" },
  { id: "risk_issue", emoji: "⚠️", name: "Risk Issue" },
  { id: "promotion_request", emoji: "🎟️", name: "Promotion Request" },
  { id: "daily_report", emoji: "📊", name: "Daily Report" },
  { id: "genie_issue", emoji: "🤖", name: "Genie Issue" },
  { id: "deposit_request", emoji: "💳", name: "Deposit Request" },
  { id: "tg_reply_threads", emoji: "💬", name: "TG Reply Threads" },
  { id: "promo_code_search", emoji: "🎟️", name: "Promo Code Search" },
  { id: "announcements", emoji: "📢", name: "Announcements" },
];
const VALID_ITEM_IDS = new Set(FEATURE_STATUS_ITEMS.map((i) => i.id));
const VALID_STATUSES = new Set(["maintenance", "coming_soon"]);
export const VALID_BYPASS_ROLES = Object.keys(ROLE_RANK); // agent, senior, admin, superadmin, owner

const DEFAULT_STATUS = { status: "active", bypassRoles: ["superadmin", "owner"] };

function statusKey(itemId) {
  return `feature-status:${itemId}`;
}

function sanitizeRoles(roles) {
  const arr = Array.isArray(roles) ? roles.filter((r) => VALID_BYPASS_ROLES.includes(r)) : [];
  // Owner can always get back in regardless of what was saved — otherwise
  // a mis-click that unchecks every role would lock EVERYONE (including
  // the person who just saved it) out of un-blocking it again.
  if (!arr.includes("owner")) arr.push("owner");
  return arr;
}

function parseStatus(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !VALID_STATUSES.has(parsed.status)) return null;
    return { status: parsed.status, bypassRoles: sanitizeRoles(parsed.bypassRoles) };
  } catch {
    return null;
  }
}

export async function getFeatureStatus(env, itemId) {
  if (!env.THREADS_KV || !VALID_ITEM_IDS.has(itemId)) return DEFAULT_STATUS;
  const raw = await env.THREADS_KV.get(statusKey(itemId));
  return parseStatus(raw) || DEFAULT_STATUS;
}

// One batched read for every item — used by the admin Settings page and
// by the lightweight public status endpoint alike.
export async function getAllFeatureStatuses(env) {
  if (!env.THREADS_KV) {
    return Object.fromEntries(FEATURE_STATUS_ITEMS.map((i) => [i.id, DEFAULT_STATUS]));
  }
  const raws = await Promise.all(FEATURE_STATUS_ITEMS.map((i) => env.THREADS_KV.get(statusKey(i.id))));
  const result = {};
  FEATURE_STATUS_ITEMS.forEach((item, i) => {
    result[item.id] = parseStatus(raws[i]) || DEFAULT_STATUS;
  });
  return result;
}

export async function saveFeatureStatus(env, itemId, { status, bypassRoles }) {
  if (!VALID_ITEM_IDS.has(itemId)) throw new Error(`Unknown item "${itemId}".`);
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status "${status}".`);
  const roles = sanitizeRoles(bypassRoles);
  await env.THREADS_KV.put(statusKey(itemId), JSON.stringify({ status, bypassRoles: roles }));
  return { status, bypassRoles: roles };
}

// Setting an item back to "Active" just deletes the override — same
// "reset to default" pattern as routes.js's deleteRouteOverride().
export async function resetFeatureStatus(env, itemId) {
  await env.THREADS_KV.delete(statusKey(itemId));
}

// True if `account`'s role is one of the item's explicitly-allowed
// bypass roles — i.e. this account is NOT blocked by a maintenance/
// coming-soon status, same as a SuperAdmin/Owner testing something
// while it's still locked for everyone else.
export function accountCanBypass(account, bypassRoles) {
  if (!account) return false; // bootstrap mode has no feature-status concept yet
  return Array.isArray(bypassRoles) && bypassRoles.includes(account.role);
}
