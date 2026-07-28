/**
 * /api/admin/routes  ("TG Group / Channel" admin page)
 *
 *   GET
 *     -> full brand x module routing grid: { brands, modules, routes }
 *        where routes["<brandId>|<moduleId>"] = { chatId, topicId, isOverride }.
 *        `isOverride: true` means it's a live KV override (edited through
 *        this page); `false` means it's still showing the hardcoded
 *        default from _shared/routing.js. Also includes `securityAlerts`
 *        (see below) — same shape, but not tied to any brand.
 *     Gated purely by the "tgRoutes" Account Management Access section —
 *     rank plays NO role here anymore (explicit business-owner decision;
 *     this used to be SuperAdmin-only with no view tier at all — now an
 *     account of any rank can be granted View-only via the checkbox
 *     alone, see canSeeAdminSection() in _shared/accounts.js).
 *
 *   POST { action:"save", brandId, moduleId, chatId, topicId } -> store an
 *     override in THREADS_KV. Takes effect on the very next form
 *     submission for that brand+module — no redeploy needed. Requires
 *     Can-Edit on "tgRoutes" (see canEditAdminSection()) — same
 *     replacement as GET, not a rank floor.
 *
 *   POST { action:"reset", brandId, moduleId } -> delete the override,
 *     reverting that brand+module back to the hardcoded default. Same
 *     Can-Edit gate as save.
 *
 * SECURITY ALERTS ROW — not a real brand/module, just reuses the exact
 * same KV-override machinery (_shared/routes.js) under the reserved
 * pseudo id pair brandId="_security", moduleId="alerts" (not a valid
 * brand id, so it can never collide with a real brand). Lets anyone with
 * Can-Edit on "tgRoutes" change where the login-security Telegram alerts
 * (functions/api/auth/login.js — unrecognized-IP warnings, account
 * auto-lock notices) go, live from the browser, instead of needing a
 * Cloudflare secret + redeploy. Falls back to the SECURITY_ALERTS_CHAT_ID
 * / SECURITY_ALERTS_TOPIC_ID env vars when nothing's been saved here yet
 * — same "KV override, env/code default underneath" layering as every
 * other row on this page.
 *
 * See functions/_shared/routes.js for the KV layer, and
 * functions/api/submit.js for where the override is actually consulted
 * at submission time.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { getAllRouteOverrides, saveRouteOverride, deleteRouteOverride, getRouteOverride } from "../../_shared/routes.js";
import { BRANDS, MODULE_META } from "../../_shared/routing.js";

const SECURITY_BRAND_ID = "_security";
const SECURITY_MODULE_ID = "alerts";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  // Visibility is now purely the "tgRoutes" checkbox — this COMPLETELY
  // REPLACES the old SuperAdmin-only floor (explicit business-owner
  // decision, same change as Whitelist IP/Agent Profile). Base staff-
  // auth floor is Senior (the lowest rank any of these 3 sections can
  // ever be granted at — see public/index.html sidebar gating).
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "tgRoutes")) return json({ ok: false, error: "You don't have access to TG Group / Channel." }, 403);

  const brandIds = Object.keys(BRANDS);
  const moduleIds = Object.keys(MODULE_META);
  const overrides = await getAllRouteOverrides(env, brandIds, moduleIds);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  const modules = moduleIds.map((id) => ({ id, name: MODULE_META[id].name, emoji: MODULE_META[id].emoji }));

  const routes = {};
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) {
      const key = `${brandId}|${moduleId}`;
      const override = overrides[key];
      if (override) {
        routes[key] = { chatId: override.chatId, topicId: override.topicId, isOverride: true };
      } else {
        const fallback = BRANDS[brandId].telegram[moduleId] || BRANDS[brandId].telegram.default || {};
        routes[key] = { chatId: fallback.chatId || "", topicId: fallback.topicId ?? null, isOverride: false };
      }
    }
  }

  const securityOverride = await getRouteOverride(env, SECURITY_BRAND_ID, SECURITY_MODULE_ID);
  const securityAlerts = securityOverride
    ? { chatId: securityOverride.chatId, topicId: securityOverride.topicId, isOverride: true }
    : { chatId: env.SECURITY_ALERTS_CHAT_ID || "", topicId: env.SECURITY_ALERTS_TOPIC_ID || null, isOverride: false };

  return json({ ok: true, brands, modules, routes, securityAlerts });
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
  // Same rank-independent model as the GET above — saving/resetting a
  // route now requires Can-Edit on "tgRoutes" (see canEditAdminSection()
  // in _shared/accounts.js), not a rank floor.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "tgRoutes")) return json({ ok: false, error: "You don't have Can-Edit access to TG Group / Channel." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brandId, moduleId } = body || {};
  const isSecurityRow = brandId === SECURITY_BRAND_ID && moduleId === SECURITY_MODULE_ID;
  if (!isSecurityRow) {
    if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
    if (!MODULE_META[moduleId]) return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }

  if (body.action === "save") {
    try {
      const saved = await saveRouteOverride(env, brandId, moduleId, { chatId: body.chatId, topicId: body.topicId });
      return json({ ok: true, route: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteRouteOverride(env, brandId, moduleId);
    if (isSecurityRow) {
      return json({ ok: true, route: { chatId: env.SECURITY_ALERTS_CHAT_ID || "", topicId: env.SECURITY_ALERTS_TOPIC_ID || null, isOverride: false } });
    }
    const fallback = BRANDS[brandId].telegram[moduleId] || BRANDS[brandId].telegram.default || {};
    return json({ ok: true, route: { chatId: fallback.chatId || "", topicId: fallback.topicId ?? null, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
