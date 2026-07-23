/**
 * GET /api/threads?q=<search>  -> { ok, active: [...], solved: [...] }
 * Lightweight summaries only (see functions/_shared/threads.js) — the
 * sidebar list. Fetch a single thread's full conversation via
 * GET /api/threads/<id>.
 *
 * Requires a logged-in account (X-Agent-Token header — see
 * _shared/accounts.js). Results are filtered server-side to only
 * the brands that account is allowed to see — an agent restricted to a
 * subset of brands never receives the other brands' summaries at all,
 * this isn't just hidden in the UI.
 */
import { listThreads } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand } from "../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) {
    return json({ ok: true, active: [], solved: [], notConfigured: true });
  }
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const q = new URL(request.url).searchParams.get("q") || "";
  const all = (await listThreads(env, { q })).filter((t) => canSeeBrand(account, t.brand));
  return json({
    ok: true,
    active: all.filter((t) => !t.solved),
    solved: all.filter((t) => t.solved),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
