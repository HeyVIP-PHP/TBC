/**
 * /api/admin/announcements  ("Announcement" management page)
 *
 *   GET  -> { ok, announcements, topics } — every announcement (any
 *     state) + the valid topic list. Gated by canSeeAdminSection(account,
 *     "announcements").
 *
 *   POST { action:"save", id?, text, topic, enabled, startAt, endAt }
 *     -> { ok, announcement }. Create (no id) or update (with id).
 *   POST { action:"delete", id } -> { ok }.
 *   Both POST actions require canEditAdminSection(account, "announcements")
 *   — not just view access.
 *
 * See _shared/announcements.js for the KV layer + validation rules.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { listAllAnnouncements, saveAnnouncement, deleteAnnouncement, ANNOUNCEMENT_TOPICS } from "../../_shared/announcements.js";
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
  if (!canSeeAdminSection(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have access to Announcements." }, 403);
  }

  const announcements = await listAllAnnouncements(env);
  return json({ ok: true, announcements, topics: ANNOUNCEMENT_TOPICS });
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
  if (!canEditAdminSection(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Announcements." }, 403);
  }
  const log = (entry) => { const p = logActivity(env, { category: "Config", ip: requestIP(request) || "unknown", ...entry }); if (waitUntil) waitUntil(p); else p.catch(() => {}); };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const actorUsername = auth.account ? auth.account.username : "bootstrap";

  if (body.action === "save") {
    try {
      const isNew = !body.id;
      const announcement = await saveAnnouncement(env, {
        id: body.id,
        text: body.text,
        topic: body.topic,
        enabled: body.enabled,
        startAt: body.startAt || null,
        endAt: body.endAt || null,
      }, actorUsername);
      log({ agent: actorUsername, action: isNew ? "Announcement Created" : "Announcement Edited", detail: `${isNew ? "Created" : "Updated"} announcement "${(body.text || "").slice(0, 80)}"` });
      return json({ ok: true, announcement });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "id is required." }, 400);
    await deleteAnnouncement(env, body.id, actorUsername);
    log({ agent: actorUsername, action: "Announcement Deleted", detail: `Deleted announcement (${body.id})` });
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
