/**
 * GET /api/announcements  -> { ok, announcements: [{id, text, topic, startAt, endAt}], rotateIntervalMs }
 *
 * Public banner endpoint — any logged-in account can call this (not
 * admin-only, the banner is a broadcast to every agent). Gated by the
 * app's Maintenance/Coming-soon system under the item id "announcements"
 * — if that's toggled off and the caller's role isn't in the bypass
 * list, this returns an EMPTY LIST (not a 403 — the banner just stays
 * quiet rather than erroring). Only returns announcements where
 * isEffectivelyActive() is true right now (see _shared/announcements.js).
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getActiveAnnouncements, getAnnouncementSettings } from "../_shared/announcements.js";
import { getFeatureStatus, accountCanBypass } from "../_shared/featureStatus.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const featureStatus = await getFeatureStatus(env, "announcements");
  if (featureStatus.status !== "active" && !accountCanBypass(account, featureStatus.bypassRoles)) {
    const { rotateIntervalMs } = await getAnnouncementSettings(env);
    return json({ ok: true, announcements: [], rotateIntervalMs });
  }

  const [active, settings] = await Promise.all([
    getActiveAnnouncements(env),
    getAnnouncementSettings(env),
  ]);

  return json({
    ok: true,
    announcements: active.map((a) => ({ id: a.id, text: a.text, topic: a.topic, startAt: a.startAt, endAt: a.endAt })),
    rotateIntervalMs: settings.rotateIntervalMs,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
