/**
 * ipAccess.js  (SERVER-ONLY)
 *
 * "IP Access" admin dashboard — sits ON TOP of the existing Office/
 * allowedIPs whitelist in accounts.js, does NOT replace it. The actual
 * security check that gates a login (officeIpCheckPasses() in
 * accounts.js: `office.allowedIPs.includes(ip)`) is completely
 * untouched — this file only adds three things around it:
 *
 *   1. PENDING REQUESTS — when a login fails because the IP isn't on the
 *      office's whitelist, instead of just alerting on Telegram (the
 *      existing behavior, still unchanged — see auth/login.js), a
 *      `ipreq:<officeId>:<ip>` record is now also created so an admin
 *      can review and Approve it from a dashboard instead of hand-typing
 *      the IP into the office's textarea. Approving still just calls
 *      saveOffice() under the hood — same code path as always.
 *   2. GLOBAL BLOCKLIST — `ipblock:<ip>` is a NEW, separate concept from
 *      the office allowlist: independent of which office/account is
 *      involved, a blocked IP is rejected outright. Checked by
 *      isIpBlocked() from both auth/login.js (before the password check)
 *      and accounts.js's verifyRequest() (before officeIpCheckPasses),
 *      so it applies to both fresh logins and already-issued tokens.
 *   3. RECORD (audit log) — same low-frequency single-key pattern as
 *      DELETION_LOG_KEY in threads.js (logDeletion/listDeletions) — this
 *      is an admin-only, occasionally-written log, nowhere near the
 *      write volume that made a shared key risky for thread updates, so
 *      it's fine to keep as one key here too.
 *
 * KV keys used (all in THREADS_KV, same namespace as everything else):
 *   ipreq:<officeId>:<ip>    → pending request record
 *   ipblock:<ip>             → global block record (office-independent)
 *   ipmeta:<officeId>:<ip>   → attribution for an approved/manual entry
 *                              in that office's allowedIPs (who added it,
 *                              how, when) — purely descriptive, never
 *                              consulted by the actual auth check.
 *   ipaccess-log             → shared audit log, same shape as
 *                              deletion-log in threads.js.
 *
 * All list()-prefix scans below are admin-dashboard-only, opened rarely
 * by a human — nowhere near the 6-second-poll frequency that forced
 * threads.js away from list() for the ticket sidebar. No caching layer
 * needed here.
 */

const IP_ACCESS_LOG_KEY = "ipaccess-log";
const MAX_LOG_SIZE = 300;

function newId() {
  return `ipa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function kvListAll(env, prefix) {
  const { keys } = await env.THREADS_KV.list({ prefix });
  const values = await Promise.all(keys.map((k) => env.THREADS_KV.get(k.name)));
  return values.filter(Boolean).map((v) => JSON.parse(v));
}

// ---- audit log ----

export async function logIpAction(env, entry) {
  const raw = await env.THREADS_KV.get(IP_ACCESS_LOG_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: newId(), ts: new Date().toISOString(), ...entry });
  await env.THREADS_KV.put(IP_ACCESS_LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG_SIZE)));
}

export async function listIpActionLog(env) {
  const raw = await env.THREADS_KV.get(IP_ACCESS_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

// ---- global blocklist ----

export async function isIpBlocked(env, ip) {
  if (!ip) return false;
  const raw = await env.THREADS_KV.get(`ipblock:${ip}`);
  return !!raw;
}

export async function blockIp(env, { ip, reason, by, byRole }) {
  const record = { ip, reason: reason || "", blockedBy: by, blockedByRole: byRole, blockedAt: new Date().toISOString() };
  await env.THREADS_KV.put(`ipblock:${ip}`, JSON.stringify(record));

  // A now-blocked IP shouldn't also sit around as a "pending" card asking
  // someone to approve it — clear any pending request(s) for this IP
  // across every office so the dashboard doesn't show contradictory
  // Pending + Blocked entries for the same address.
  const { keys } = await env.THREADS_KV.list({ prefix: "ipreq:" });
  const matches = keys.filter((k) => k.name.endsWith(`:${ip}`));
  await Promise.all(matches.map((k) => env.THREADS_KV.delete(k.name)));

  await logIpAction(env, { action: "block", category: "blocked", ip, by, byRole, detail: reason || "" });
  return record;
}

export async function unblockIp(env, { ip, by, byRole }) {
  await env.THREADS_KV.delete(`ipblock:${ip}`);
  await logIpAction(env, { action: "unblock", category: "blocked", ip, by, byRole });
}

export async function listBlockedIps(env) {
  return kvListAll(env, "ipblock:");
}

// ---- pending requests ----

// Called from auth/login.js the moment a login fails specifically
// because of the office/IP rule (NOT for wrong-password or no-office —
// see the matching call site there for why). Fire-and-forget via
// waitUntil, same as the existing Telegram alert it sits next to.
// Silently no-ops if the IP is already blocked or already sitting in
// that office's allowedIPs (the latter shouldn't normally happen since
// officeIpCheckPasses would have passed already, but guards against a
// race between two near-simultaneous requests).
export async function recordPendingIpAttempt(env, { ip, officeId, officeName, username, userAgent, country, city }) {
  if (!ip || !officeId) return;
  if (await isIpBlocked(env, ip)) return;

  const key = `ipreq:${officeId}:${ip}`;
  const raw = await env.THREADS_KV.get(key);
  const now = new Date().toISOString();

  if (raw) {
    const existing = JSON.parse(raw);
    existing.attempts = (existing.attempts || 1) + 1;
    existing.lastAttemptAt = now;
    existing.username = username; // most recent account to try, in case it differs
    existing.userAgent = userAgent;
    await env.THREADS_KV.put(key, JSON.stringify(existing));
    return existing;
  }

  const record = { ip, officeId, officeName, username, userAgent, country: country || null, city: city || null, createdAt: now, lastAttemptAt: now, attempts: 1 };
  await env.THREADS_KV.put(key, JSON.stringify(record));
  // Only the FIRST time this ip+office pair shows up goes into the audit
  // log — logging every retry would flood the Record with noise the
  // same way an un-deduplicated login-fail counter would (see the
  // LOGIN FAIL tracking notes in auth/login.js for the same principle).
  // `category` lets the dashboard group Record entries under the same
  // card (Pending/Approved/Blocked/Manually) they visually belong to,
  // without the frontend having to infer it from the action name.
  await logIpAction(env, { action: "pending-created", category: "pending", ip, officeId, officeName, detail: username || "" });
  return record;
}

export async function listPendingIps(env) {
  return kvListAll(env, "ipreq:");
}

async function deletePendingRequest(env, officeId, ip) {
  await env.THREADS_KV.delete(`ipreq:${officeId}:${ip}`);
}

// ---- approved / manual entries (office.allowedIPs + attribution) ----
//
// saveOffice()/getOffice() (accounts.js) remain the ONLY source of truth
// for what's actually enforced at login — ipmeta:<officeId>:<ip> is
// purely descriptive metadata layered on top for the dashboard's
// "who added this and how" columns, never consulted by the auth check
// itself. Any IP already sitting in an office's allowedIPs from BEFORE
// this feature existed has no ipmeta record — listApprovedIps() below
// labels those "legacy" rather than guessing.

export async function approveIpRequest(env, { officeId, ip, by, byRole, getOffice, saveOffice, setAccountLocked }) {
  const key = `ipreq:${officeId}:${ip}`;
  const raw = await env.THREADS_KV.get(key);
  const pending = raw ? JSON.parse(raw) : null;

  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");

  const allowedIPs = office.allowedIPs.includes(ip) ? office.allowedIPs : [...office.allowedIPs, ip];
  await saveOffice(env, { id: office.id, name: office.name, allowedIPs });

  const now = new Date().toISOString();
  await env.THREADS_KV.put(`ipmeta:${officeId}:${ip}`, JSON.stringify({ ip, officeId, source: "approved", addedBy: by, addedByRole: byRole, addedAt: now }));
  await deletePendingRequest(env, officeId, ip);

  // Approving unblocks in the SAME action — see the auto-lock note in
  // auth/login.js: an account that got auto-locked purely because it
  // kept retrying from this not-yet-whitelisted IP shouldn't need a
  // second, separate "unlock" click once the IP itself is approved.
  // No-ops harmlessly if the account was never locked.
  if (pending && pending.username && setAccountLocked) {
    await setAccountLocked(env, pending.username, false);
  }

  await logIpAction(env, { action: "approve", category: "approved", ip, officeId, officeName: office.name, by, byRole, detail: pending?.username || "" });
  return { office, pending };
}

export async function rejectIpRequest(env, { officeId, ip, by, byRole }) {
  await deletePendingRequest(env, officeId, ip);
  await logIpAction(env, { action: "reject", category: "pending", ip, officeId, by, byRole });
}

export async function addManualIp(env, { officeId, ip, by, byRole, getOffice, saveOffice }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  if (office.allowedIPs.includes(ip)) throw new Error("That IP is already on this office's whitelist.");

  await saveOffice(env, { id: office.id, name: office.name, allowedIPs: [...office.allowedIPs, ip] });
  const now = new Date().toISOString();
  await env.THREADS_KV.put(`ipmeta:${officeId}:${ip}`, JSON.stringify({ ip, officeId, source: "manual", addedBy: by, addedByRole: byRole, addedAt: now }));
  await logIpAction(env, { action: "manual-add", category: "approved", ip, officeId, officeName: office.name, by, byRole });
  return office;
}

export async function removeApprovedIp(env, { officeId, ip, by, byRole, getOffice, saveOffice }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");

  await saveOffice(env, { id: office.id, name: office.name, allowedIPs: office.allowedIPs.filter((x) => x !== ip) });
  await env.THREADS_KV.delete(`ipmeta:${officeId}:${ip}`);
  await logIpAction(env, { action: "remove", category: "approved", ip, officeId, officeName: office.name, by, byRole });
}

// Combines every office's allowedIPs (ground truth) with ipmeta
// attribution (best-effort — "legacy" for anything saved before this
// feature existed, i.e. no ipmeta record for that office+ip pair).
export async function listApprovedIps(env, { listOffices }) {
  const offices = await listOffices(env);
  const metaList = await kvListAll(env, "ipmeta:");
  const metaByKey = new Map(metaList.map((m) => [`${m.officeId}:${m.ip}`, m]));

  const out = [];
  for (const office of offices) {
    for (const ip of office.allowedIPs || []) {
      const meta = metaByKey.get(`${office.id}:${ip}`);
      out.push({
        ip,
        officeId: office.id,
        officeName: office.name,
        source: meta?.source || "legacy",
        addedBy: meta?.addedBy || null,
        addedByRole: meta?.addedByRole || null,
        addedAt: meta?.addedAt || null,
      });
    }
  }
  return out;
}

// ---- dashboard aggregate ----
//
// One call for the whole "IP Access" admin page: stats + 3 buckets
// (Pending / Approved / Blocked) + the audit log. There USED to be a
// 4th bucket ("Manually added", split out of Approved by `source`) but
// that distinction turned out to be more confusing than useful in
// practice — an IP that's on the whitelist is on the whitelist, however
// it got there. `source`/`addedBy`/`addedByRole` are still attached to
// each entry (from listApprovedIps()) purely for the "Added by" column
// and the Record table, not for bucketing.
export async function getIpAccessDashboard(env, { listOffices }) {
  const [pending, blocked, approved] = await Promise.all([
    listPendingIps(env),
    listBlockedIps(env),
    listApprovedIps(env, { listOffices }),
  ]);
  const record = await listIpActionLog(env);

  return {
    stats: {
      total: approved.length + pending.length + blocked.length,
      approved: approved.length,
      pending: pending.length,
      blocked: blocked.length,
    },
    pending,
    approved,
    blocked,
    record,
  };
}
