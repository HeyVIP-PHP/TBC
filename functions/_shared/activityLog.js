/**
 * activityLog.js  (SERVER-ONLY)
 *
 * "🔎 Activity Logs" — a site-wide audit trail: who did what, when, from
 * which IP. Covers Auth (login success/failure, auto-lock), Account
 * (create/delete/role/permissions/password/lock), Thread (ticket
 * create/reply/solve/delete/edit/recall), and Config (routing, IP
 * whitelist, announcements, maintenance mode, brand links, etc).
 *
 * STORAGE DESIGN — deliberately copies the lesson learned in threads.js,
 * not the older deletion-log.js/ipaccess-log single-shared-key pattern:
 *
 *   - ONE INDEPENDENT KV KEY PER LOG ENTRY (`activitylog:<ts>:<rand>`),
 *     never a shared array key. threads.js's own header explains why: a
 *     shared key can take at most 1 write/sec, and this feature can be
 *     triggered by several agents acting concurrently (logins, ticket
 *     edits, admin changes) — a shared "index" key would just recreate
 *     the exact write-contention bug threads.js already had to fix once.
 *   - The full entry is stored as this key's KV *metadata* (not its
 *     value) — same trick threads.js uses for the sidebar summary — so
 *     listing entries via `list()` never needs a follow-up `get()` per
 *     entry. `detail` is hard-capped (see clip() below) to stay well
 *     under KV's 1024-byte metadata limit per key.
 *   - Unlike threads.html (polled every 6s), this page is opened
 *     occasionally by an Owner/delegated account reviewing history — NOT
 *     auto-polled — so a plain `list()` per page load/refresh is cheap
 *     against the shared 1,000 list()-calls/day budget flagged in
 *     threads.js. Do not add auto-polling to activity-logs.html without
 *     re-reading that budget note first.
 *
 * WRITE VOLUME — logActivity() is called from every mutating endpoint in
 * the app (see the "logActivity(...)" call sites). Combined with
 * whatever else is already writing to THREADS_KV (ticket saves, presence
 * heartbeats, etc.), this DOES add to the shared 1,000 writes/day
 * free-tier budget. Deliberately NOT logging high-frequency/low-value
 * reads (searches, attachment previews, presence heartbeats) — only
 * genuine state-changing actions. If this ever becomes a real budget
 * concern, the fix is the same one threads.js already documents
 * (batch/patch writes), not turning logging off silently.
 *
 * RETENTION — 90 days, swept opportunistically on a 5% sample of
 * listActivityLog() calls (mirrors threads.js's SWEEP_SAMPLE_RATE
 * pattern exactly) rather than every call or a separate cron job.
 *
 * FAILURE MODE — logActivity() NEVER throws and never blocks the action
 * it's describing. Every call site should fire this via `waitUntil()`
 * where a `waitUntil` is available (same fire-and-forget reasoning as
 * the Telegram security alerts in auth/login.js) so a KV hiccup here can
 * never turn into a broken login/save/delete. Where no `waitUntil` is
 * available (e.g. inside an already-`waitUntil`-wrapped callback), call
 * it directly — its own try/catch still guarantees it can't throw.
 */

const PREFIX = "activitylog:";
const RETENTION_DAYS = 90;
const SWEEP_SAMPLE_RATE = 0.05;

// The 4 categories used for filtering on the page — kept here as the
// single source of truth; activity-logs.html's filter dropdown should
// match this list by hand (small, static, not worth an extra API call).
export const ACTIVITY_CATEGORIES = ["Auth", "Account", "Thread", "Config"];

function clip(str, max) {
  const s = String(str ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function newKey(ts) {
  return `${PREFIX}${ts}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Records one audit-log entry. Never throws — a logging failure must
 * never break the real action it's describing.
 *
 *   category — one of ACTIVITY_CATEGORIES ("Auth"/"Account"/"Thread"/"Config")
 *   action   — short label, e.g. "Login", "Role Changed", "Ticket Deleted"
 *   agent    — username of whoever performed the action (or attempted to,
 *              for failed logins — may be a username that doesn't
 *              actually exist, that's fine, it's what was TYPED)
 *   detail   — one-line, human-readable description. For edits/recalls,
 *              callers build an "old → new" string themselves before
 *              calling this (see functions/api/threads/[id].js) — this
 *              function just clips whatever it's given, it doesn't diff.
 *   ip       — requestIP(request), or "unknown" if not available.
 */
export async function logActivity(env, { category, action, agent, detail, ip }) {
  try {
    if (!env || !env.THREADS_KV) return;
    const ts = Date.now();
    const entry = {
      ts,
      category: clip(category || "Config", 20),
      action: clip(action || "", 60),
      agent: clip(agent || "unknown", 80),
      detail: clip(detail || "", 700),
      ip: clip(ip || "unknown", 60),
    };
    await env.THREADS_KV.put(newKey(ts), "1", { metadata: entry });
  } catch {
    // Logging must never break the caller's real action.
  }
}

function isExpired(entry, now) {
  return (now - entry.ts) / 86400000 > RETENTION_DAYS;
}

// Opportunistic cleanup — same reasoning/rate as threads.js's
// sweepExpired(): retention is measured in days, so there's no need to
// check on every single call, just often enough that entries don't pile
// up indefinitely.
async function sweepExpired(env, entries) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return;
  const now = Date.now();
  const expiredKeys = entries.filter((e) => isExpired(e, now)).map((e) => e.__key);
  if (!expiredKeys.length) return;
  await Promise.all(expiredKeys.map((k) => env.THREADS_KV.delete(k).catch(() => {})));
}

/**
 * Lists activity log entries, newest first. Optional filters are applied
 * client-side against the already-fetched page (same "load once, filter
 * in the browser" approach threads.html uses for its search box) — this
 * just controls how many entries come back from KV.
 */
export async function listActivityLog(env, { limit = 1000 } = {}) {
  if (!env || !env.THREADS_KV) return [];
  const all = [];
  let cursor;
  // Keys are `activitylog:<13-digit-ms-timestamp>:<rand>` — lexicographic
  // order on the full key string is NOT chronological once the day
  // rolls over inconsistently across cursors, so we always sort by the
  // parsed `ts` in metadata below rather than trusting key order.
  do {
    const page = await env.THREADS_KV.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) {
      if (k.metadata) all.push({ ...k.metadata, __key: k.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
    // Hard safety cap — this is a review page, not a paging API; if
    // retention is ever misconfigured (e.g. RETENTION_DAYS raised very
    // high) this stops a single page load from scanning unbounded pages.
  } while (cursor && all.length < 20000);

  all.sort((a, b) => b.ts - a.ts);

  // Fire-and-forget, doesn't block the response.
  sweepExpired(env, all).catch(() => {});

  return all.slice(0, limit).map(({ __key, ...rest }) => rest);
}
