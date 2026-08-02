/**
 * GET /api/mention-candidates?brandId=<id>&module=<moduleId>
 *   -> { ok, candidates: [{ handle, from, lastSeen }] }
 *
 * Backs the reply box's "@ tag username" autocomplete (public/threads.html).
 * Candidates are scoped to one brand+module pairing — see the big comment
 * on rememberMentionCandidate() in functions/_shared/threads.js for why
 * (mirrors routing.js: each brand+module is its own TG group/topic, so a
 * name recorded under a different pairing likely isn't even reachable
 * with an @ mention here).
 *
 * Requires login, same as every other TG Reply Threads endpoint. Brand
 * access is enforced the same way /api/threads does — an agent scoped
 * away from a brand gets an empty list, not the other brand's names.
 */
import { getMentionCandidates } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand } from "../_shared/accounts.js";
import { BRANDS } from "../_shared/routing.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: true, candidates: [] });

  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") || "";
  const moduleId = url.searchParams.get("module") || "";
  if (!brandId || !moduleId) return json({ ok: false, error: "Missing brandId or module." }, 400);

  const brand = BRANDS[brandId];
  if (!brand || !canSeeBrand(account, brand.name)) {
    // Same "don't even confirm anything about a brand you can't see"
    // reasoning as the rest of this app — empty list, not a 403 that
    // leaks whether brandId is even a real id.
    return json({ ok: true, candidates: [] });
  }

  const candidates = await getMentionCandidates(env, brandId, moduleId);
  return json({ ok: true, candidates });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
