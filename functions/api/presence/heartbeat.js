/**
 * /api/presence/heartbeat  (Active Agents online-status panel)
 *
 * POST { action: "heartbeat" | "offline", device? }
 *   -> { ok, written, status }
 *
 * DELIBERATELY NOT gated by canSeeAdminSection(account, "activeAgents")
 * — every logged-in account needs to be able to report "I'm online",
 * same as everyone can post their own thread replies. Only READING the
 * roster (list.js / record.js) is permission-gated. This is the
 * write-permission / read-permission split described in the migration
 * doc: writing your own heartbeat is universal, seeing everyone else's
 * status is not.
 *
 * Identity comes from the session token (verifyRequest) — an account
 * can only ever write ITS OWN presence record, there's no username
 * field in the request body to spoof.
 */
import { verifyRequest } from "../../_shared/accounts.js";
import { recordHeartbeat, markOffline } from "../../_shared/presence.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);

  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Not authorized." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const device = typeof body.device === "string" ? body.device.slice(0, 80) : null;

  if (body.action === "offline") {
    const result = await markOffline(env, account.username);
    return json({ ok: true, ...result });
  }

  const result = await recordHeartbeat(env, account.username, { device });
  return json({ ok: true, ...result });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
