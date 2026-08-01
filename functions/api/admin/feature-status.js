/**
 * /api/admin/feature-status  ("Settings" admin page)
 *
 *   GET  -> { ok, items: [{ id, emoji, name, status, bypassRank }] }
 *     Gated by the "settings" Account Management Access section — same
 *     view/edit model as tgRoutes/whitelistIp (see canSeeAdminSection()/
 *     canEditAdminSection() in _shared/accounts.js).
 *
 *   POST { action:"save", itemId, status, bypassRank } -> maintenance/
 *     coming_soon. Requires Can-Edit on "settings".
 *   POST { action:"reset", itemId } -> back to Active. Same gate.
 *
 * See _shared/featureStatus.js for the KV layer and the enforcement
 * points (submit.js, threads.js, promo-search.js, and the client-side
 * blocking in index.html/app.js/threads.html/promo.html).
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { FEATURE_STATUS_ITEMS, getAllFeatureStatuses, saveFeatureStatus, resetFeatureStatus } from "../../_shared/featureStatus.js";

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
  if (!canSeeAdminSection(auth.account, "settings")) return json({ ok: false, error: "You don't have access to Settings." }, 403);

  const statuses = await getAllFeatureStatuses(env);
  const items = FEATURE_STATUS_ITEMS.map((i) => ({ ...i, ...statuses[i.id] }));
  return json({ ok: true, items });
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
  if (!canEditAdminSection(auth.account, "settings")) return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { itemId } = body || {};
  if (!FEATURE_STATUS_ITEMS.some((i) => i.id === itemId)) {
    return json({ ok: false, error: `Unknown item "${itemId}".` }, 400);
  }

  if (body.action === "save") {
    try {
      const saved = await saveFeatureStatus(env, itemId, { status: body.status, bypassRank: body.bypassRank });
      return json({ ok: true, item: saved });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await resetFeatureStatus(env, itemId);
    return json({ ok: true, item: { status: "active", bypassRank: "superadmin" } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
