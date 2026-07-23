/**
 * GET /api/deletion-log  -> { ok, entries }
 *
 * Not linked from anywhere in the agent-facing UI, AND now also requires
 * a logged-in account ranked admin-or-above (see _shared/accounts.js) —
 * the URL alone used to be the only thing keeping it private; now a
 * non-admin agent/senior account gets a 401 even if they find the URL.
 *
 * Uses the rank-based authenticateAdmin() alias (ROLE_RANK >= admin), NOT
 * a literal `role === "admin"` string check — a SuperAdmin's role string
 * is literally "superadmin", not "admin", so a literal compare here
 * silently 401s every SuperAdmin. threads.html's own client-side
 * visibility check for this section already went through this exact
 * fix once (see the comment in bootDashboard() there); this file had
 * fallen out of sync with that fix — same class of bug, different file.
 */
import { listDeletions } from "../_shared/threads.js";
import { authenticateAdmin } from "../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);
  const entries = await listDeletions(env);
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
