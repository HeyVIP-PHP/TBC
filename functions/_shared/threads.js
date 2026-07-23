/**
 * threads.js  (SERVER-ONLY)
 *
 * Storage for the "TG Reply Threads" feature — tracks each form submission
 * that was sent to Telegram, plus every reply that lands in that Telegram
 * thread (via webhook) or is sent back out from the dashboard.
 *
 * Backed by Cloudflare KV (binding: THREADS_KV — see wrangler.toml).
 * Two kinds of keys:
 *   thread:<id>          → full thread record (JSON), with a lightweight
 *                           summary attached as this key's KV *metadata*
 *   msgid:<chatId>:<mid>  → thread id (string) — lets the Telegram webhook
 *                           find which thread a reply belongs to in O(1)
 *
 * NO SHARED "index" KEY ANYMORE. Every write used to also rewrite one
 * single `"index"` JSON blob (the sidebar's data source) — but Cloudflare
 * KV allows at most 1 write/sec to the SAME key, and every reply/submit/
 * solve-toggle/edit was hitting that one key, so concurrent agents could
 * genuinely 429 each other. Instead, each thread's own summary now rides
 * along as *metadata* on that thread's own `put()` — a different key per
 * thread, so two agents touching two different tickets never contend with
 * each other at all (only two edits to the exact same ticket in the same
 * second still could, which is a much smaller, much rarer surface). The
 * sidebar is built with `THREADS_KV.list({ prefix: "thread:" })`, which
 * returns every thread's metadata without fetching the full record —
 * cheap per-call, BUT Cloudflare's free plan caps `list()` at 1,000
 * calls/day, completely separate from (and far stricter than) the
 * 100,000 reads/day budget. A naive "call list() on every listThreads()"
 * (the original version of this redesign) blew through that in a
 * couple of hours of normal 6-second sidebar polling — see the
 * LIST_CACHE_KEY / LIST_CACHE_TTL_MS / DAILY_SCAN_LIMIT section below for
 * the fix (a real list() scan now only happens at most once every 2
 * minutes, cached in between, AND is hard-capped at 800 real scans per
 * UTC day no matter what). Keep this in mind before adding any OTHER list() calls
 * anywhere in this codebase — they all share the same 1,000/day budget.
 *
 * Trade-off: `list()` is only *eventually* consistent across Cloudflare's
 * edge (per Cloudflare's docs, propagation is usually fast but isn't
 * instant/global like a single-key read), so a brand-new ticket can take
 * a little longer to appear in someone else's sidebar than it used to.
 * Given the previous alternative was writes silently dropped/delayed
 * under contention, this is a straightforward trade in the sidebar's
 * favor. Any `thread:<id>` key saved before this change has no metadata
 * yet — `listThreads()` below transparently falls back to reading that
 * one thread's full record and re-saves it with metadata attached so it
 * only ever needs to do that once per pre-existing ticket. That healing is
 * capped per call (MAX_HEAL_PER_CALL, near listThreads() below) — right
 * after this ships, EVERY pre-existing ticket needs healing at once, and
 * Cloudflare caps how many subrequests one call can make, so healing them
 * all in a single call risked 503ing the whole page (this actually
 * happened during testing). The sidebar catches up over a few 6-second
 * polls instead — a one-time, self-resolving cost.
 *
 * AUTO-CLEANUP — controls how many KV "writes"/"deletes" you burn per day
 * (see the free-plan limits: 1,000 writes/day, 1,000 deletes/day). Adjust
 * the two numbers below to change how long tickets stick around; set
 * either to `Infinity` to disable that rule entirely. Cleanup runs
 * opportunistically (piggy-backing on normal reads), since Cloudflare
 * Pages Functions don't support Cron Triggers.
 */

// Solved tickets older than this many days are auto-deleted.
const SOLVED_RETENTION_DAYS = 30;
// Any ticket (solved or not) with zero activity for this many days is
// auto-deleted as a safety net, so a never-solved ticket can't sit forever.
const STALE_RETENTION_DAYS = 90;

function newId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Still used for the low-frequency admin deletion log (one shared key, but
// only written on an actual delete/recall action — nowhere near the write
// volume that made "index" a problem, so it's left as a single key with a
// retry instead of also being broken apart).
async function kvPutWithRetry(env, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await env.THREADS_KV.put(key, value);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(150 * (i + 1) + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cloudflare KV metadata is capped at 1024 bytes (serialized) per key —
// well clear of what a sidebar row needs, but title/submitter are free-
// text and `extraSearchText` folds in every custom form-field value, so
// both are hard-capped defensively rather than trusting upstream length.
function clip(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}

// Lightweight summary of a thread — this is what actually gets stored as
// this key's KV metadata (see saveThread) and is all the sidebar needs to
// render a row without fetching the full record. msgIds/chatId/topicId are
// deliberately NOT included: they're only needed once an agent opens a
// specific thread, which fetches the full `thread:<id>` record anyway.
function summarize(thread) {
  // Extra searchable text beyond title/submitter/brand (which are already
  // their own metadata fields, so listThreads() can match them without
  // needing them duplicated in here too) — e.g. an account ID typed into
  // one of the module's custom fields. Capped hard so a ticket with many/
  // long custom fields can never push this key's metadata near the limit.
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

// Every write to a thread's own record goes through this — saves the full
// JSON as the value, and the lightweight summary as this key's metadata,
// in one KV write. No second key touched, so no shared hot key.
async function saveThread(env, thread) {
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread), {
    metadata: summarize(thread),
  });
}

// Deletes a thread's KV record plus every msgid: pointer that leads to it
// (the root submission message, and any reply sent back out from the
// dashboard). Parallelized (Promise.all) instead of one-at-a-time — these
// are all different keys, so there's no per-key rate limit to worry about
// here, only wall-clock time, and a thread with many messages/attachments
// could otherwise mean a long chain of sequential round-trips.
async function purgeThread(env, thread) {
  const ids = thread.msgIds || [];
  await Promise.all([
    env.THREADS_KV.delete(`thread:${thread.id}`),
    ...ids.map((mid) => env.THREADS_KV.delete(`msgid:${thread.chatId}:${mid}`)),
  ]);
}

function isExpired(t, now) {
  const daysSince = (iso) => (now - new Date(iso).getTime()) / 86400000;
  if (t.solved && t.solvedAt && daysSince(t.solvedAt) > SOLVED_RETENTION_DAYS) return true;
  if (daysSince(t.lastActivity) > STALE_RETENTION_DAYS) return true;
  return false;
}

// Sweeps a batch of summaries for expired entries and deletes their KV
// records (full record fetched first, since purging needs msgIds which
// aren't in the summary — see summarize() above). Runs on a sample of
// listThreads() calls rather than every one, since retention windows are
// measured in DAYS, not seconds, and this is a read-path cost now (no
// hot-key write to protect), so it's kept cheap mainly to avoid doing
// extra KV round-trips on every single sidebar refresh.
const SWEEP_SAMPLE_RATE = 0.05;

async function sweepExpired(env, list) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return list;
  const now = Date.now();
  const keep = [];
  const expiredIds = [];
  for (const t of list) {
    if (!t.deleted && isExpired(t, now)) expiredIds.push(t.id);
    else keep.push(t);
  }
  if (expiredIds.length) {
    await Promise.all(
      expiredIds.map(async (id) => {
        const thread = await getThread(env, id);
        if (thread) await purgeThread(env, thread);
      })
    );
  }
  return keep;
}

export async function createThread(env, { module: moduleId, moduleName, icon, accent, brand, title, submitter, chatId, topicId, rootMessageId, rootText, hasMedia, attachmentFileIds, summary }) {
  const now = new Date().toISOString();
  const thread = {
    id: newId(),
    module: moduleId,
    moduleName,
    icon,
    accent,
    brand,
    title,
    submitter,
    submittedAt: now,
    lastActivity: now,
    chatId: String(chatId),
    topicId: topicId ?? null,
    rootMessageId,
    rootText: rootText || "",
    rootEdited: false,
    hasMedia: !!hasMedia,
    // Telegram's own file_id(s) for the original submission's photo(s)/
    // document(s) — same idea and same viewer (/api/attachment/[fileId].js)
    // as reply attachments (see functions/api/threads/[id].js), just
    // captured at ticket-creation time instead of reply time. Empty array
    // for text-only tickets, or if the module doesn't collect attachments.
    attachmentFileIds: attachmentFileIds || [],
    rootRecalled: false,
    msgIds: [rootMessageId],
    summary: summary || [],
    messages: [],
    solved: false,
    solvedAt: null,
    deleted: false,
  };
  await Promise.all([
    saveThread(env, thread),
    env.THREADS_KV.put(`msgid:${thread.chatId}:${rootMessageId}`, thread.id),
  ]);
  await patchListCache(env, thread); // instant sidebar visibility — see that function's comment for why
  return thread;
}

export async function getThread(env, id) {
  const raw = await env.THREADS_KV.get(`thread:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function findThreadIdByMessage(env, chatId, messageId) {
  return env.THREADS_KV.get(`msgid:${chatId}:${messageId}`);
}

// One-time migration cost, per pre-existing ticket: fetch its full record
// once and re-save it with metadata attached, so future list() calls can
// read it cheaply. Isolated into its own function so listThreads() can
// run a bounded batch of these in parallel (see MAX_HEAL_PER_CALL below).
async function healThread(env, keyName) {
  const raw = await env.THREADS_KV.get(keyName);
  if (!raw) return null;
  const thread = JSON.parse(raw);
  const meta = summarize(thread);
  try {
    await env.THREADS_KV.put(keyName, raw, { metadata: meta });
  } catch {
    // Non-fatal — it'll just get healed again on a future list().
  }
  return meta;
}

// Cloudflare caps how many subrequests a single Function invocation can
// make (well under what a naive "heal every pre-existing ticket in one
// pass" loop can hit). Right after this metadata-based sidebar first
// ships, EVERY existing `thread:*` key needs healing at once — with
// enough tickets, healing them all serially (or even all in parallel) in
// ONE call risks tripping that limit and 503ing the whole page, which is
// exactly what showed up in testing. Capping how many get healed per
// call bounds the damage to a small, fixed number of extra KV round
// trips; whatever's left over just gets picked up on the next real scan
// (see LIST_CACHE_TTL_MS below) — a one-time, self-resolving cost.
const MAX_HEAL_PER_CALL = 15;

// The actual KV `list()` walk — separated out from listThreads() below so
// it can be called from BEHIND a cache (see getFreshOrCachedEntries).
// Returns every thread's summary (unsorted, still includes soft-deleted
// entries — filtering happens in listThreads()).
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

// ---- Cached sidebar scan ----
//
// Cloudflare's Workers KV free plan caps `list()` at 1,000 calls/day —
// completely separate from (and far lower than) the 100,000 reads/day
// budget, and NOT documented anywhere near as prominently. Every call to
// listThreads() used to run a real list() scan, and the sidebar polls
// every 6 seconds — do the math on ANY single agent leaving the
// dashboard open for a couple of hours and it's obvious this was always
// going to blow the daily list() quota, not a maybe. This is what
// actually caused the "Unexpected server error: KV list() limit
// exceeded for the day" failure that showed up in testing — a real
// architectural miss when the shared "index" key was first replaced
// with list()+metadata (that redesign fixed the KV *write*-contention
// problem, but nobody checked list()'s own separate, much stricter
// quota at the time).
//
// Fix: a real list() scan now only happens at most once every
// LIST_CACHE_TTL_MS — the result is cached in ONE KV key
// (LIST_CACHE_KEY) and every listThreads() call in between just reads
// that cache (a cheap get(), which draws from the 100,000/day read
// budget instead, with tons of headroom). 10 minutes keeps real list()
// calls to at most ~144/day even under continuous nonstop polling all
// day — comfortable headroom under 1,000, and also keeps the *write*
// side (saving the cache) well under the SEPARATE 1,000 writes/day
// budget, which every ticket submit/reply/solve-toggle also draws from.
//
// Trade-off, stated plainly: a brand-new ticket, or a solved/reopened
// status change, can now take up to ~2 minutes to show up in the
// sidebar for other agents (an already-open conversation stays fully
// real-time regardless — that's a direct-by-ID get(), never affected by
// any of this). Given the alternative was the whole sidebar hard-failing
// once the daily list() quota ran out, this is a straightforward trade
// in the sidebar's favor, same reasoning as the write-contention fix
// before it.
//
// Resilience: if a real scan fails (e.g. the daily list() quota is
// ALREADY exhausted for the day when this runs), fall back to whatever
// is cached — even hours-stale data — rather than fail the request
// outright. Only throws if there's truly nothing cached to fall back to.
const LIST_CACHE_KEY = "thread-list-cache";
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the standalone cron-worker's Cron Trigger interval. Was 2 minutes originally; raised because the cron worker's OWN writes (2 KV puts per run, regardless of interval) were consuming most of the separate 1,000 writes/day free-tier budget at that frequency — see wrangler.toml in the cron-worker folder for the full writeup of that miscalculation and why 10 minutes is the corrected value.

// ---- Hard daily ceiling on real list() calls, on top of the 10-minute
// throttle above ----
//
// The 10-minute throttle alone caps real scans at ~144/day under normal
// conditions — comfortably under Cloudflare's 1,000/day limit. But it's
// a "soft" guarantee: if several agents' polls land in the exact same
// instant right as the cache expires, each could independently decide
// "the cache is stale, I'll do a real scan" before any of them has
// written the refreshed cache back — a small, bounded race, not a
// guaranteed-zero one. This counter is the actual hard backstop the
// business owner asked for: an explicit daily count, stored in KV,
// checked BEFORE every real scan. Once it reaches DAILY_SCAN_LIMIT, no
// further real list() calls happen for the rest of the UTC day no
// matter what — the sidebar just keeps serving whatever's cached (even
// if that means it stops updating for the remainder of the day), which
// is a far better failure mode than risking a repeat of the outright
// "KV list() limit exceeded" error. Resets automatically at UTC
// midnight, same as Cloudflare's own quota window, since the counter
// key stores which UTC calendar date it's counting for and starts over
// the moment that date changes.
const DAILY_SCAN_LIMIT = 800;
const SCAN_COUNTER_KEY = "thread-list-scan-counter";

function utcDateString(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

// Returns true if a real scan is allowed to proceed right now (and, if
// so, has already recorded this call against today's count). Returns
// false if today's DAILY_SCAN_LIMIT has already been reached.
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
    // If we can't even persist the counter, err on the side of caution
    // and still allow this one scan through — the 10-minute throttle is
    // still there as a backup limiter either way.
  }
  return true;
}

async function getCachedScan(env) {
  try {
    const raw = await env.THREADS_KV.get(LIST_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- Instant sidebar updates for OUR OWN actions, decoupled from the
// cron worker's refresh interval ----
//
// LIST_CACHE_TTL_MS (10 minutes) controls how long the sidebar can go
// between full re-scans — that's the right knob for "how stale can
// things get if nobody's actively doing anything," but it's the WRONG
// knob for "how fast does MY OWN new ticket / solve-toggle / reply show
// up" — those are things we already know about the instant they happen
// (we're the ones doing them), no need to wait for the next scheduled
// scan to notice something we already have full details on. Business
// owner was right to push back hard on "up to 10 minutes for a new
// ticket to appear" for a live CS team — that's not acceptable, and
// tying ticket visibility to the write-budget-driven scan interval was
// the wrong way to solve the original quota problem.
//
// This patches the EXISTING cached entries list in place (one targeted
// KV get + put, not a full re-scan) every time something we already
// know the outcome of happens — see the call sites in createThread(),
// appendMessage(), setSolved(), and softDeleteThread() below. Costs 1
// extra read + 1 extra write per action — negligible compared to the
// action's own KV writes (saving the thread itself), and NOT tied to
// polling frequency at all, so it doesn't reintroduce the write-budget
// problem the cron interval was raised to fix. If there's no cache yet
// (nobody's loaded the sidebar since the last full scan), this is a
// harmless no-op — the next real scan builds it fresh anyway.
async function patchListCache(env, thread, { remove } = {}) {
  try {
    const cached = await getCachedScan(env);
    if (!cached) return; // nothing to patch yet — fine, next real scan builds it
    const idx = cached.entries.findIndex((e) => e.id === thread.id);
    if (remove) {
      if (idx >= 0) cached.entries.splice(idx, 1);
    } else {
      const meta = summarize(thread);
      if (idx >= 0) cached.entries[idx] = meta;
      else cached.entries.unshift(meta); // new ticket — put it at the front, sorting happens on read anyway
    }
    // generatedAt is deliberately left untouched — this is a targeted
    // patch, not a fresh scan, and keeping the original timestamp means
    // the periodic full re-scan (which also heals/cleans up drift) still
    // runs on its normal schedule rather than being perpetually pushed
    // back by ongoing activity.
    await env.THREADS_KV.put(LIST_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Best-effort only — worst case, this specific update shows up on
    // the next real scan instead of instantly. Never worth failing the
    // actual action (creating a ticket, replying, etc.) over this.
  }
}

async function getFreshOrCachedEntries(env) {
  const cached = await getCachedScan(env);
  const now = Date.now();
  if (cached && now - cached.generatedAt < LIST_CACHE_TTL_MS) {
    return cached.entries;
  }
  // Cache is missing or stale — normally that means "do a real scan,"
  // but only if today's hard ceiling hasn't been hit yet.
  const allowed = await tryReserveScanSlot(env);
  if (!allowed) {
    if (cached) return cached.entries; // stale is fine — never worth risking the real quota over
    return []; // no cache AND no budget left for today — degrade to an empty list rather than throw
  }
  try {
    const entries = await scanThreadsFromKV(env);
    // Best-effort — a failed cache write should never break the read
    // path; the next call just re-scans instead of reusing a cache.
    try {
      await env.THREADS_KV.put(LIST_CACHE_KEY, JSON.stringify({ generatedAt: now, entries }));
    } catch {
      // ignored
    }
    return entries;
  } catch (err) {
    if (cached) return cached.entries; // stale beats broken
    throw err;
  }
}

// Sidebar list — served from the cache above almost all the time; only
// touches KV's list() directly when that cache is missing or stale.
export async function listThreads(env, { q } = {}) {
  const results = await getFreshOrCachedEntries(env);

  const swept = await sweepExpired(env, results);
  const visible = swept.filter((t) => !t.deleted);
  visible.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  if (!q) return visible;
  const needle = q.toLowerCase();
  return visible.filter((t) => {
    if ((t.extraSearchText || "").includes(needle)) return true;
    return (
      (t.submitter || "").toLowerCase().includes(needle) ||
      (t.title || "").toLowerCase().includes(needle) ||
      (t.brand || "").toLowerCase().includes(needle)
    );
  });
}

export async function appendMessage(env, threadId, message) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages.push(message);
  thread.lastActivity = message.ts;
  // Only genuine, explicit replies ever reach here for non-self messages
  // (see telegram-webhook.js) — so if one lands on an already-solved
  // ticket, that's a deliberate "actually, still need to talk about this"
  // signal, and it's safe to reopen.
  if (thread.solved && !message.self) {
    thread.solved = false;
    thread.solvedAt = null;
  }
  // Track this outbound message's id (if Telegram returned one) so
  // replies-to-replies still resolve back to the same thread, and so
  // cleanup can find and delete every msgid: pointer for this thread.
  if (message.messageId) {
    thread.msgIds = [...(thread.msgIds || [thread.rootMessageId]), message.messageId];
  }
  const writes = [saveThread(env, thread)];
  if (message.messageId) {
    writes.push(env.THREADS_KV.put(`msgid:${thread.chatId}:${message.messageId}`, thread.id));
  }
  await Promise.all(writes);
  await patchListCache(env, thread); // instant sidebar update — reply count / reopened status
  return thread;
}

export async function setSolved(env, threadId, solved) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.solved = solved;
  thread.solvedAt = solved ? new Date().toISOString() : null;
  await saveThread(env, thread);
  await patchListCache(env, thread); // instant sidebar update — solved/unsolved toggle
  return thread;
}

// Root ticket message (the original submission) was edited on Telegram —
// update the text we keep. The structured `summary` (Promotion/TID/etc.
// rows) was captured once at submit time and can't be safely re-parsed
// out of free-form edited text, so we flag the thread as edited — the
// dashboard shows this raw text instead of the now-possibly-stale summary.
export async function updateRootText(env, threadId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.rootText = text;
  thread.rootEdited = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// ---- Deletion history — every "delete/recall" action, kept separately
// from thread storage so it survives even after a thread itself is gone.
// Not linked from anywhere in the agent-facing UI. Low-frequency
// (admin-only actions), so left as one shared key with a retry — see the
// note on kvPutWithRetry above for why this one's different from the old
// "index" key.
const DELETION_LOG_KEY = "deletion-log";
const MAX_LOG_SIZE = 500;

export async function logDeletion(env, entry) {
  const raw = await env.THREADS_KV.get(DELETION_LOG_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: newId(), ts: new Date().toISOString(), by: entry.by || null, ...entry });
  await kvPutWithRetry(env, DELETION_LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG_SIZE)));
}

export async function listDeletions(env) {
  const raw = await env.THREADS_KV.get(DELETION_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Root ticket message was deleted from Telegram — keep the tracking record
// (conversation history, sheet row, etc. are untouched) but flag it so the
// dashboard can show "original message recalled" instead of pretending it's
// still there.
export async function markRootRecalled(env, threadId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.rootRecalled = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// A self-sent reply was edited on Telegram — update its stored text.
export async function editMessageInThread(env, threadId, messageId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  const msg = thread.messages.find((m) => m.self && m.messageId === messageId);
  if (!msg) return null;
  msg.text = text;
  msg.editedAt = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// A self-sent reply was recalled from Telegram — remove it from the
// conversation (matches how Telegram itself just removes it, no trace).
export async function removeMessageFromThread(env, threadId, messageId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages = thread.messages.filter((m) => !(m.self && m.messageId === messageId));
  await saveThread(env, thread);
  return thread;
}

export async function softDeleteThread(env, threadId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  await purgeThread(env, thread);
  await patchListCache(env, thread, { remove: true }); // instant sidebar update — drop it immediately, don't wait for the next scan to notice it's gone
  return thread;
}
