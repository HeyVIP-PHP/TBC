/**
 * announcements.js  (SERVER-ONLY)
 *
 * Site-wide "REMINDER" banner + its admin management page. Backs
 * public/announcement-banner.js (every logged-in page) and
 * public/announcements.html (the management UI).
 *
 * Reuses THREADS_KV (no new namespace) — three keys, all JSON:
 *   announcements            -> array of announcement records
 *   announcement-settings    -> { rotateIntervalMs }
 *
 * Announcements realistically never number more than a handful, so this
 * is a single get()/put() on one JSON-array key — deliberately NOT the
 * heavier list()+metadata pattern threads.js uses for the (potentially
 * thousands-of-records) ticket list. Don't copy that pattern here.
 *
 * SCHEDULING — no cron job, none needed. isEffectivelyActive() below is
 * evaluated fresh on every read (every banner poll). Nothing ever writes
 * to KV when a schedule window opens or closes — "auto on / auto off" is
 * purely a side effect of recomputing this on each request. `enabled` is
 * a separate manual master switch, independent of the schedule.
 */

const ANNOUNCEMENTS_KEY = "announcements";
const SETTINGS_KEY = "announcement-settings";

export const ANNOUNCEMENT_TOPICS = [
  "Friendly reminder",
  "Game maintenance",
  "System maintenance",
  "Deposit / Withdraw Issues",
];

const DEFAULT_ROTATE_INTERVAL_MS = 5000;
const MIN_ROTATE_INTERVAL_MS = 1000;

export function isEffectivelyActive(a, now = Date.now()) {
  if (!a || !a.enabled) return false;
  if (a.startAt && now < new Date(a.startAt).getTime()) return false;
  if (a.endAt && now > new Date(a.endAt).getTime()) return false;
  return true;
}

async function readAll(env) {
  if (!env.THREADS_KV) return [];
  const raw = await env.THREADS_KV.get(ANNOUNCEMENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(env, list) {
  await env.THREADS_KV.put(ANNOUNCEMENTS_KEY, JSON.stringify(list));
}

// Every announcement, any state — admin view.
export async function listAllAnnouncements(env) {
  const all = await readAll(env);
  // Newest-created first, so the management sidebar shows recent work
  // at the top.
  return all.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

// Only effectively-active ones, sorted oldest-active-first — banner view,
// so the rotation order stays stable rather than reshuffling every poll.
export async function getActiveAnnouncements(env) {
  const all = await readAll(env);
  const now = Date.now();
  return all
    .filter((a) => isEffectivelyActive(a, now))
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export async function getAnnouncement(env, id) {
  const all = await readAll(env);
  return all.find((a) => a.id === id) || null;
}

// Create (no `id`) or update (with `id`). Validates `topic` against the
// fixed list, falling back to the first topic if invalid/missing.
export async function saveAnnouncement(env, { id, text, topic, enabled, startAt, endAt }, actorUsername) {
  if (!text || !String(text).trim()) throw new Error("Message text is required.");
  if (startAt && endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error("End time must be after start time.");
  }
  const safeTopic = ANNOUNCEMENT_TOPICS.includes(topic) ? topic : ANNOUNCEMENT_TOPICS[0];
  const now = new Date().toISOString();
  const all = await readAll(env);

  let record;
  let action;
  if (id) {
    const idx = all.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error("Announcement not found.");
    record = {
      ...all[idx],
      text: String(text).trim(),
      topic: safeTopic,
      enabled: !!enabled,
      startAt: startAt || null,
      endAt: endAt || null,
      updatedBy: actorUsername,
      updatedAt: now,
    };
    all[idx] = record;
    action = "edited";
  } else {
    record = {
      id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: String(text).trim(),
      topic: safeTopic,
      enabled: !!enabled,
      startAt: startAt || null,
      endAt: endAt || null,
      createdBy: actorUsername,
      createdAt: now,
      updatedBy: actorUsername,
      updatedAt: now,
    };
    all.unshift(record);
    action = "created";
  }

  await writeAll(env, all);
  await logToSheet(env, action, record, actorUsername);
  return record;
}

export async function deleteAnnouncement(env, id, actorUsername) {
  const all = await readAll(env);
  const record = all.find((a) => a.id === id);
  const remaining = all.filter((a) => a.id !== id);
  await writeAll(env, remaining);
  if (record) await logToSheet(env, "deleted", record, actorUsername);
}

export async function getAnnouncementSettings(env) {
  if (!env.THREADS_KV) return { rotateIntervalMs: DEFAULT_ROTATE_INTERVAL_MS };
  const raw = await env.THREADS_KV.get(SETTINGS_KEY);
  if (!raw) return { rotateIntervalMs: DEFAULT_ROTATE_INTERVAL_MS };
  try {
    const parsed = JSON.parse(raw);
    const ms = Number(parsed.rotateIntervalMs);
    return { rotateIntervalMs: Number.isFinite(ms) && ms >= MIN_ROTATE_INTERVAL_MS ? ms : DEFAULT_ROTATE_INTERVAL_MS };
  } catch {
    return { rotateIntervalMs: DEFAULT_ROTATE_INTERVAL_MS };
  }
}

export async function saveAnnouncementSettings(env, { rotateIntervalMs }) {
  const ms = Number(rotateIntervalMs);
  const safeMs = Number.isFinite(ms) ? Math.max(MIN_ROTATE_INTERVAL_MS, Math.round(ms)) : DEFAULT_ROTATE_INTERVAL_MS;
  await env.THREADS_KV.put(SETTINGS_KEY, JSON.stringify({ rotateIntervalMs: safeMs }));
  return { rotateIntervalMs: safeMs };
}

// Best-effort audit log — no-ops silently if ANNOUNCEMENT_LOG_SHEET_ID
// isn't set. Never let a Sheets hiccup fail the actual save/delete.
async function logToSheet(env, action, announcement, actorUsername) {
  if (!env.ANNOUNCEMENT_LOG_SHEET_ID) return;
  try {
    const { appendRowToSheet } = await import("./googleSheets.js");
    await appendRowToSheet(env, env.ANNOUNCEMENT_LOG_SHEET_ID, env.ANNOUNCEMENT_LOG_TAB || "Log", {
      timestamp: new Date().toISOString(),
      action,
      actor: actorUsername || "",
      topic: announcement.topic || "",
      text: announcement.text || "",
      enabled: announcement.enabled ? "yes" : "no",
      startAt: announcement.startAt || "",
      endAt: announcement.endAt || "",
      id: announcement.id || "",
    });
  } catch (e) {
    // Best-effort only — swallow so a Sheets/network hiccup never fails
    // the caller's actual save/delete.
    console.error("announcement sheet log failed:", e && e.message || e);
  }
}
