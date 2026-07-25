/**
 * Self-contained, single-file version of the cron worker — paste this
 * WHOLE FILE directly into Cloudflare's dashboard Worker editor (no
 * command line, no Wrangler needed). See "Deploy via the Cloudflare
 * dashboard (no command line)" in README.md for the click-by-click
 * steps this file goes with.
 *
 * ⚠️ This duplicates a few functions out of functions/_shared/threads.js
 * (summarize, healThread, scanThreadsFromKV, tryReserveScanSlot) instead
 * of importing them, because the dashboard's editor only supports one
 * file with no build step / imports. If you ever change how a "thread
 * summary" is shaped in threads.js, or change LIST_CACHE_TTL_MS /
 * DAILY_SCAN_LIMIT there, this file's copies below need the same edit
 * by hand — they will silently drift otherwise. If you deployed via
 * Wrangler + src/index.js instead (see the "Deploy via command line"
 * section of README.md), none of this applies — that version imports
 * threads.js directly and can never drift.
 */

const LIST_CACHE_KEY = "thread-list-cache";
const DAILY_SCAN_LIMIT = 800; // keep in sync with functions/_shared/threads.js
const SCAN_COUNTER_KEY = "thread-list-scan-counter";
const MAX_HEAL_PER_CALL = 15; // keep in sync with functions/_shared/threads.js

function clip(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}

function summarize(thread) {
  const extraSearchText = clip(
    (thread.summary || []).map((s) => s.value).filter(Boolean).join(" ").toLowerCase(),
    300
  );
  return {
    id: thread.id,
    module: thread.module,
    moduleName: thread.moduleName,
    icon: thread.icon,
    accent: thread.accent,
    brand: thread.brand,
    title: clip(thread.title, 200),
    submitter: clip(thread.submitter, 100),
    submittedAt: thread.submittedAt,
    lastActivity: thread.lastActivity,
    solved: thread.solved,
    solvedAt: thread.solvedAt,
    deleted: !!thread.deleted,
    replyCount: thread.messages.length,
    extraSearchText,
  };
}

async function healThread(env, keyName) {
  const raw = await env.THREADS_KV.get(keyName);
  if (!raw) return null;
  const thread = JSON.parse(raw);
  const meta = summarize(thread);
  try {
    await env.THREADS_KV.put(keyName, raw, { metadata: meta });
  } catch {
    // Non-fatal — it'll just get healed again on a future scan.
  }
  return meta;
}

async function scanThreadsFromKV(env) {
  const withMeta = [];
  const needsHeal = [];
  let cursor;
  do {
    const page = await env.THREADS_KV.list({ prefix: "thread:", cursor, limit: 1000 });
    for (const key of page.keys) {
      if (key.metadata) withMeta.push(key.metadata);
      else needsHeal.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const healed = await Promise.all(needsHeal.slice(0, MAX_HEAL_PER_CALL).map((name) => healThread(env, name)));
  return [...withMeta, ...healed.filter(Boolean)];
}

function utcDateString(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

async function tryReserveScanSlot(env) {
  const today = utcDateString(new Date());
  let counter;
  try {
    const raw = await env.THREADS_KV.get(SCAN_COUNTER_KEY);
    counter = raw ? JSON.parse(raw) : null;
  } catch {
    counter = null;
  }
  if (!counter || counter.date !== today) counter = { date: today, count: 0 };
  if (counter.count >= DAILY_SCAN_LIMIT) return false;
  counter.count += 1;
  try {
    await env.THREADS_KV.put(SCAN_COUNTER_KEY, JSON.stringify(counter));
  } catch {
    // Still allow this one scan through even if the counter itself
    // couldn't be saved — the 10-minute Cron Trigger interval is still
    // a backup limiter either way.
  }
  return true;
}

async function refreshThreadListCache(env) {
  const allowed = await tryReserveScanSlot(env);
  if (!allowed) return { refreshed: false, reason: "daily-scan-limit-reached" };
  const entries = await scanThreadsFromKV(env);
  await env.THREADS_KV.put(LIST_CACHE_KEY, JSON.stringify({ generatedAt: Date.now(), entries }));
  return { refreshed: true, count: entries.length };
}

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRefresh(env));
  },

  // GET this Worker's own URL directly (not through the cron trigger) to
  // test it manually — handy for confirming the KV binding is correct
  // before waiting around for the real schedule.
  async fetch(request, env) {
    const result = await runRefresh(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json" },
    });
  },
};
