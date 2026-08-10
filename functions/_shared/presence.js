/**
 * presence.js  (SERVER-ONLY)
 *
 * "Active Agents" online-status data layer — ported from the standalone
 * INR-active-agents project (see Active-Agents-架构说明与迁移指南.md for
 * the full design writeup). Reuses this project's existing THREADS_KV
 * binding under a `presence:` prefix — no new KV namespace.
 *
 * ---------------------------------------------------------------------
 * WHY THIS FILE EXISTS: WRITE AMPLIFICATION
 * ---------------------------------------------------------------------
 * The browser sends a heartbeat every ~15s. If every heartbeat wrote to
 * KV, one agent alone would be ~240 writes/hour — Cloudflare KV's free
 * tier does not survive more than a couple of hours of that across a
 * whole team. Everything below exists to solve that, without the
 * frontend needing to know or care (throttling is a pure backend
 * behavior — see recordHeartbeat()).
 *
 * ---------------------------------------------------------------------
 * THRESHOLD COUPLING — READ BEFORE CHANGING EITHER NUMBER
 * ---------------------------------------------------------------------
 *   MIN_KV_WRITE_INTERVAL_MS = 2 minutes   (server-side write throttle)
 *   heartbeat interval       ~ 15 seconds  (client, presence-heartbeat.js)
 *   worst-case background-tab browser throttling ~ 60 seconds
 *                     ↓
 *   worst-case gap between two REAL writes ≈ write-throttle window
 *                                            + one heartbeat interval
 *                                            + browser throttling slop
 *                     ↓
 *   OFFLINE_AFTER_MS must stay comfortably above that worst case, or a
 *   genuinely-online agent gets misclassified as offline.
 *
 * Current numbers leave >2x margin (5 min offline threshold vs. a worst
 * case around 2–3 min). If you ever change MIN_KV_WRITE_INTERVAL_MS or
 * the client heartbeat interval, re-check this margin — tuning one
 * without the other is the single most common way to break this system
 * silently (agents flicker offline while still actively working).
 */

const MIN_KV_WRITE_INTERVAL_MS = 2 * 60 * 1000; // throttle: 1 real write / 2 min while status is unchanged
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // no fresh write in 5 min -> treat as offline (read-time inference)
const MAX_CREDIT_MS = OFFLINE_AFTER_MS; // cap on how much elapsed time can be credited to "online" in one hop

const CURRENT_PREFIX = "presence:current:";
const DAILY_PREFIX = "presence:daily:";

function currentKey(username) {
  return `${CURRENT_PREFIX}${username.toLowerCase()}`;
}
function dailyKey(username, dayKey) {
  return `${DAILY_PREFIX}${username.toLowerCase()}:${dayKey}`;
}

/**
 * "Today" is always computed in the business timezone, independent of
 * the agent's own browser timezone and independent of which Cloudflare
 * region happened to run this request. Change TIMEZONE if this project
 * ever needs a different business day boundary.
 */
const TIMEZONE = "Asia/Colombo";
export function dayKeyColombo(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

async function getCurrent(env, username) {
  const raw = await env.THREADS_KV.get(currentKey(username));
  return raw ? JSON.parse(raw) : null;
}

async function getDaily(env, username, dayKey) {
  const raw = await env.THREADS_KV.get(dailyKey(username, dayKey));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Read-time status inference. "online -> offline" is NEVER written
 * proactively (nothing calls "I just went silent") — it's only ever
 * inferred here, from staleness, at read time. Only the opposite
 * direction (an explicit tab-close/logout) is ever written directly,
 * by markOffline() below. This is the general shape for any
 * heartbeat/health-check system: absence can only be inferred, never
 * self-reported.
 */
export function deriveStatus(current, now = Date.now()) {
  if (!current) return "offline";
  if (current.status === "offline") return "offline";
  const age = now - current.lastWriteTime;
  if (age > OFFLINE_AFTER_MS) return "offline";
  return "online";
}

/**
 * Called on every heartbeat POST. Throttles real KV writes to at most
 * one per MIN_KV_WRITE_INTERVAL_MS while status stays "online" — the
 * client can (and should) keep heartbeating every 15s regardless, this
 * function just decides whether that heartbeat actually touches KV.
 *
 * When it does write, it also credits elapsed time (capped at
 * MAX_CREDIT_MS) onto today's running total — capped so that a laptop
 * waking from hours of sleep doesn't get hours of bogus "online" time;
 * the cap sits exactly at the offline threshold, so anything the system
 * would have called "offline" anyway is never credited.
 */
export async function recordHeartbeat(env, username, { device } = {}, now = Date.now()) {
  const uname = username.toLowerCase();
  const current = await getCurrent(env, uname);
  const wasAlreadyOnline = !!current && current.status === "online";
  const elapsedSinceWrite = current ? now - current.lastWriteTime : Infinity;

  if (wasAlreadyOnline && elapsedSinceWrite < MIN_KV_WRITE_INTERVAL_MS) {
    return { written: false, status: "online" };
  }

  const dayKey = dayKeyColombo(new Date(now));
  let daily = await getDaily(env, uname, dayKey);
  if (!daily) daily = { totalOnlineMs: 0, lastActiveAt: null };

  if (wasAlreadyOnline) {
    const creditMs = Math.min(elapsedSinceWrite, MAX_CREDIT_MS);
    daily.totalOnlineMs = (daily.totalOnlineMs || 0) + creditMs;
  }
  daily.lastActiveAt = new Date(now).toISOString();

  const nextCurrent = {
    status: "online",
    lastWriteTime: now,
    lastDevice: device || (current && current.lastDevice) || null,
  };

  await Promise.all([
    env.THREADS_KV.put(currentKey(uname), JSON.stringify(nextCurrent)),
    env.THREADS_KV.put(dailyKey(uname, dayKey), JSON.stringify(daily)),
  ]);

  return { written: true, status: "online" };
}

/**
 * Explicit offline report — tab close (`pagehide`) or logout. This is
 * the ONE place "offline" is ever written proactively; everything else
 * that shows "offline" got there via deriveStatus()'s staleness check.
 * Also credits any not-yet-flushed online time up to this moment (same
 * cap logic as recordHeartbeat) so the last stretch before closing the
 * tab isn't lost.
 */
export async function markOffline(env, username, now = Date.now()) {
  const uname = username.toLowerCase();
  const current = await getCurrent(env, uname);

  if (current && current.status === "online") {
    const dayKey = dayKeyColombo(new Date(now));
    let daily = await getDaily(env, uname, dayKey);
    if (!daily) daily = { totalOnlineMs: 0, lastActiveAt: null };
    const creditMs = Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    daily.totalOnlineMs = (daily.totalOnlineMs || 0) + creditMs;
    daily.lastActiveAt = new Date(now).toISOString();
    await env.THREADS_KV.put(dailyKey(uname, dayKey), JSON.stringify(daily));
  }

  await env.THREADS_KV.put(currentKey(uname), JSON.stringify({
    status: "offline",
    lastWriteTime: now,
    lastDevice: current ? current.lastDevice : null,
  }));

  return { written: true, status: "offline" };
}

/**
 * Roster + today's stats for a given list of usernames (already
 * permission-filtered by the caller — this function does not itself
 * apply any admin-section or owner-visibility rule, see
 * functions/api/presence/list.js for that).
 *
 * "Read-time top-up": if someone is currently online, the time since
 * their last real write is added to today's total IN THE RESPONSE ONLY
 * (never written back to KV) — this is what makes the "online Xm today"
 * number look like it's ticking up continuously on a 10s poll, instead
 * of jumping in 2-minute steps, without costing any extra KV writes.
 */
export async function listPresence(env, usernames, now = Date.now()) {
  const dayKey = dayKeyColombo(new Date(now));
  const results = await Promise.all(usernames.map(async (username) => {
    const uname = username.toLowerCase();
    const [current, daily] = await Promise.all([
      getCurrent(env, uname),
      getDaily(env, uname, dayKey),
    ]);
    const status = deriveStatus(current, now);
    let liveOnlineMs = daily ? daily.totalOnlineMs || 0 : 0;
    if (status === "online" && current) {
      liveOnlineMs += Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    }
    return {
      username: uname,
      status,
      lastActiveAt: current ? new Date(current.lastWriteTime).toISOString() : (daily ? daily.lastActiveAt : null),
      lastDevice: current ? current.lastDevice : null,
      todayOnlineMs: liveOnlineMs,
    };
  }));
  return results;
}

/**
 * Single agent's daily history over the last `days` days (including
 * today), most recent first. Today's entry gets the same read-time
 * top-up as listPresence() above.
 */
export async function getDailyRecord(env, username, days = 14, now = Date.now()) {
  const uname = username.toLowerCase();
  const todayKey = dayKeyColombo(new Date(now));
  const current = await getCurrent(env, uname);
  const status = deriveStatus(current, now);

  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    dayKeys.push(dayKeyColombo(d));
  }

  const records = await Promise.all(dayKeys.map(async (dayKey) => {
    const daily = await getDaily(env, uname, dayKey);
    let totalOnlineMs = daily ? daily.totalOnlineMs || 0 : 0;
    if (dayKey === todayKey && status === "online" && current) {
      totalOnlineMs += Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    }
    return {
      date: dayKey,
      totalOnlineMs,
      lastActiveAt: daily ? daily.lastActiveAt : null,
    };
  }));

  return records;
}

export const PRESENCE_CONFIG = { MIN_KV_WRITE_INTERVAL_MS, OFFLINE_AFTER_MS, MAX_CREDIT_MS };
