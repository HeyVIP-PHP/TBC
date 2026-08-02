/**
 * POST /api/admin/mention-backfill  ("Settings" -> "Run backfill")
 *   Body: { cursor? }  -> { ok, scanned, done, cursor }
 *
 * One-time (well — re-runnable any time, but only needs running once)
 * historical backfill for the @ Tag Username registry: the incremental
 * path (rememberMentionCandidate() in functions/_shared/threads.js, wired
 * into appendMessage()) only started recording handles the moment this
 * feature shipped — tickets from before that have replies sitting in
 * `thread:*` records that were never fed into the registry. This walks
 * every existing thread once and backfills them.
 *
 * Paginated (100 threads/call, same page size threads.js's own scan
 * uses) rather than one giant sweep — Cloudflare caps how many
 * subrequests a single Function invocation can make, and a business with
 * enough ticket history could have thousands of `thread:*` keys. The
 * frontend (public/index.html) calls this in a loop, passing back the
 * `cursor` each response returns, until `done`. Safe to stop partway
 * through and resume (or re-run from scratch) any time — this only ever
 * MERGES handles into the registry (see mergeMentionCandidatesBatch in
 * threads.js), never removes anything, so re-scanning the same page
 * twice is a harmless no-op the second time.
 *
 * Gated the same as the rest of Settings (Can-Edit on the "settings"
 * Account Management Access section) — this is a bulk KV-writing admin
 * action, not something every agent should be able to trigger.
 */
import { authenticateStaff, ROLE_RANK, canEditAdminSection } from "../../_shared/accounts.js";
import { backfillMentionCandidatesPage } from "../../_shared/threads.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "settings")) return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);

  const body = await request.json().catch(() => ({}));
  const result = await backfillMentionCandidatesPage(env, body.cursor || undefined);
  return json({ ok: true, ...result });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
