/**
 * /api/admin/activity-logs
 *
 *   GET -> { ok, entries: [{ ts, category, action, agent, detail, ip }, ...] }
 *
 * Gated by canSeeAdminSection(account, "activityLogs") — same
 * deny-by-default pattern as every other Account Management Access
 * section (whitelistIp, agentProfile, announcements, activeAgents...).
 * Owner sees it by default and can grant it to ANY rank, including
 * Agent — see canSeeAdminSection() in _shared/accounts.js, nothing
 * special-cased for this section, it's a plain entry in ADMIN_SECTIONS.
 *
 * View-only, no POST — there's no "edit" action for an audit log (same
 * shape as activeAgents, not in EDITABLE_ADMIN_SECTIONS).
 *
 * Filtering (category/agent/text search) all happens client-side in
 * activity-logs.html against the single fetched batch, same "load once,
 * filter in the browser" approach threads.html uses for its search box
 * — see _shared/activityLog.js's header for why this endpoint isn't
 * paginated/polled.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection } from "../../_shared/accounts.js";
import { listActivityLog } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);

  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "activityLogs")) {
    return json({ ok: false, error: "You don't have access to Activity Logs." }, 403);
  }

  const entries = await listActivityLog(env, { limit: 1000 });
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
