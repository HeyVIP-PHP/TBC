/**
 * /api/admin/announcement-settings — rotation-speed control
 *
 *   GET  / POST { rotateIntervalMs } -> { ok, rotateIntervalMs }
 *
 * Gated by the "settings" Account Management Access section (same tier
 * as the Maintenance/Coming-soon controls) — deliberately NOT the
 * "announcements" section, since this is a global display-behavior
 * setting that conceptually belongs with the rest of Settings, not with
 * the announcements themselves: "manage the announcements" and "manage
 * how the banner behaves" are different concerns.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { getAnnouncementSettings, saveAnnouncementSettings } from "../../_shared/announcements.js";
import { logActivity } from "../../_shared/activityLog.js";

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

  const { rotateIntervalMs } = await getAnnouncementSettings(env);
  return json({ ok: true, rotateIntervalMs });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
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

  const saved = await saveAnnouncementSettings(env, { rotateIntervalMs: body.rotateIntervalMs });
  const logCall = logActivity(env, { category: "Config", agent: auth.account ? auth.account.username : "bootstrap", action: "Announcement Settings Changed", detail: `Rotation interval set to ${saved.rotateIntervalMs}ms`, ip: requestIP(request) || "unknown" });
  if (waitUntil) waitUntil(logCall); else logCall.catch(() => {});
  return json({ ok: true, ...saved });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
