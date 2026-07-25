/**
 * Standalone Cloudflare Worker, deployed SEPARATELY from the main Pages
 * site — its only job is to run on a Cron Trigger and keep the TG Reply
 * Threads sidebar cache warm, so agents don't have to be the one whose
 * poll happens to land right as the 10-minute cache goes stale.
 *
 * Entirely optional. The site works completely fine without this ever
 * being deployed — functions/_shared/threads.js already self-heals the
 * cache lazily on demand (see LIST_CACHE_TTL_MS in that file). All this
 * adds is: the cache refreshes proactively on a predictable schedule,
 * even during a quiet stretch with nobody actively polling.
 *
 * Shares functions/_shared/threads.js with the main site via a relative
 * import — NOT a copy-pasted duplicate. Keep it that way; if the two
 * ever drift, the "144 scans/day" and "800/day hard ceiling" budget math
 * in threads.js's comments stops being trustworthy for either deployment.
 */
import { refreshThreadListCache } from "../../functions/_shared/threads.js";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRefresh(env));
  },

  // GET this Worker's own URL directly (not through the cron trigger) to
  // test it manually — handy for confirming the KV binding + deploy are
  // both actually correct before waiting around for the real schedule.
  async fetch(request, env) {
    const result = await runRefresh(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json" },
    });
  },
};

async function runRefresh(env) {
  try {
    const result = await refreshThreadListCache(env);
    console.log("[cron-worker] thread list cache refresh:", result);
    return result;
  } catch (err) {
    console.error("[cron-worker] refresh failed:", err);
    return { refreshed: false, error: err.message || String(err) };
  }
}
