/**
 * accounts.js  (SERVER-ONLY)
 *
 * Backs the TG Reply Threads account system: Offices (a name + a small
 * allowed-IP list) and Accounts (username/password/role/brand access,
 * each belonging to one Office). Stored in the same THREADS_KV namespace
 * as everything else in this feature, under their own key prefixes so
 * nothing collides with thread records:
 *
 *   office:<id>        → { id, name, allowedIPs: [...] }
 *   offices-index       → JSON array of office ids
 *   account:<username>  → { username, salt, hash, role, officeId, allowedBrands }
 *   accounts-index       → JSON array of usernames
 *
 * DESIGN NOTE — SESSION TOKENS (replaces the old "no session" model).
 *
 * SECURITY INCIDENT, 2026-07-20: the original design stored the agent's
 * PLAINTEXT password in the browser's localStorage (`agentAuth`) and
 * re-sent it on every request via X-Agent-User/X-Agent-Pass headers, so
 * every protected endpoint could re-verify the password hash + office IP
 * on every single call without a session store. This was found to be
 * trivially readable via browser DevTools (F12 → Application → Local
 * Storage) by anyone with physical/remote access to an already-logged-in
 * browser — i.e. the password was sitting in the clear, independent of
 * how strong the server-side hash was. Replaced with signed session
 * tokens:
 *   - On login, the server issues a signed token (HMAC-SHA256 over
 *     {username, tokenVersion, iat, exp} using the SESSION_TOKEN_SECRET
 *     env secret) — see issueToken()/verifyToken() below.
 *   - The browser stores ONLY this token (never the password) and sends
 *     it as X-Agent-Token on every request.
 *   - verifyToken() checks the signature + expiry; verifyRequest() then
 *     re-fetches the account and checks it's not locked AND that the
 *     token's `tokenVersion` still matches the account's current
 *     tokenVersion (bumped on every password change and every lock/
 *     unlock — see saveAccount()/setAccountLocked()), so a token that
 *     predates a password reset or a lock immediately stops working,
 *     same guarantee the old design had.
 *   - Tokens expire after TOKEN_TTL_MS regardless (hard ceiling on top
 *     of the client-side 2h idle timeout in authguard.js).
 * REQUIRES a new Cloudflare secret: SESSION_TOKEN_SECRET (any long
 * random string — used only to sign/verify tokens, never sent to the
 * browser). If unset, issueToken()/verifyToken() throw/fail closed
 * rather than silently signing with a guessable key.
 */

const OFFICES_INDEX_KEY = "offices-index";
const ACCOUNTS_INDEX_KEY = "accounts-index";

// Role hierarchy — each tier can act on anything strictly below it (see
// the per-endpoint checks in functions/api/admin/*.js and
// functions/api/account/*.js for exactly what each tier can do).
export const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3 };
const VALID_ROLES = Object.keys(ROLE_RANK);
export function rankOf(role) { return ROLE_RANK[role] ?? ROLE_RANK.agent; }

// ---- password hashing (PBKDF2 via Web Crypto, available in Workers) ----
//
// ITERATION COUNT — lowered this session, see below for why.
//
// This system has no session/token (see the design note above): every
// single request re-verifies the password from scratch via
// verifyPassword(), including every 6-second sidebar poll. Cloudflare
// Workers' Free plan caps CPU time at 10ms per request — and PBKDF2 at
// the OLD count (100,000 iterations) was landing right at or over that
// ceiling on every authenticated call, especially once you add the rest
// of the request's own JS work on top. Cloudflare's own docs flag
// exactly this: "heavier workloads that handle authentication... typically
// use 10-20ms" of CPU time on Free — this is a documented, known way to
// blow the Free plan's budget, not a misconfiguration on our end. When a
// request exceeds the CPU limit, Cloudflare kills the isolate at the
// platform level — that's NOT a catchable JS exception, so none of the
// try/catch safety nets added earlier this session could ever have caught
// it; it surfaces to the browser as a bare network-level 503, no JSON
// body, which matches exactly what showed up in testing.
//
// Lowering the iteration count directly cuts that CPU cost. Every
// EXISTING account's password hash was computed at the OLD count and
// will only ever verify correctly against that count — so instead of a
// single global constant, each account record stores the iteration count
// that was actually used for IT specifically (`iterations` field, added
// this session). New accounts / password resets from now on get the new
// lower count; every account created before this change keeps working
// unmodified, verified at the count it was actually hashed with. Nothing
// needs a forced password reset.
const PBKDF2_ITERATIONS_CURRENT = 10000; // used for any password hashed from now on
const PBKDF2_ITERATIONS_LEGACY_FALLBACK = 100000; // only for account records saved before this session, which predate the `iterations` field

async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS_CURRENT) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)), iterations };
}

// `iterations` MUST be the count that particular account's hash was
// actually created with (account.iterations) — falls back to the old
// hardcoded value only for account records saved before this field
// existed, so nothing that already worked breaks.
export async function verifyPassword(password, salt, expectedHash, iterations = PBKDF2_ITERATIONS_LEGACY_FALLBACK) {
  const { hash } = await hashPassword(password, salt, iterations);
  return timingSafeEqual(hash, expectedHash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- session tokens (HMAC-SHA256, replaces sending the password on
// every request — see the DESIGN NOTE at the top of this file) ----

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h hard ceiling, independent of the client-side 2h idle timeout

async function getSigningKey(env) {
  if (!env.SESSION_TOKEN_SECRET) {
    throw new Error("SESSION_TOKEN_SECRET is not configured — set it in Cloudflare (Settings → Environment variables, Production) to any long random string.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Issues a signed session token for an account, good for TOKEN_TTL_MS.
 * Payload carries the account's CURRENT tokenVersion, so this token
 * stops verifying the instant that version changes (password reset,
 * lock, or unlock) — see verifyToken()/verifyRequest().
 */
export async function issueToken(env, account) {
  const payload = {
    u: account.username,
    v: account.tokenVersion || 0,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getSigningKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies a token's signature and expiry. Does NOT check tokenVersion
 * or lock state against the account — that requires a KV read, done by
 * the caller (verifyRequest()) once it has both the token payload and
 * the current account record. Returns the decoded payload ({u, v, iat,
 * exp}) on success, or null on any failure (bad signature, malformed,
 * expired, secret not configured).
 */
export async function verifyToken(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const key = await getSigningKey(env);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    if (!payload.u || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- offices ----

export async function listOffices(env) {
  const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
  const ids = raw ? JSON.parse(raw) : [];
  const offices = await Promise.all(ids.map((id) => env.THREADS_KV.get(`office:${id}`)));
  return offices.filter(Boolean).map((o) => JSON.parse(o));
}

export async function getOffice(env, id) {
  const raw = await env.THREADS_KV.get(`office:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveOffice(env, { id, name, allowedIPs }) {
  const officeId = id || `off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const office = { id: officeId, name, allowedIPs: (allowedIPs || []).map((ip) => ip.trim()).filter(Boolean) };
  await env.THREADS_KV.put(`office:${officeId}`, JSON.stringify(office));
  if (!id) {
    const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    if (!ids.includes(officeId)) {
      ids.unshift(officeId);
      await env.THREADS_KV.put(OFFICES_INDEX_KEY, JSON.stringify(ids));
    }
  }
  return office;
}

export async function deleteOffice(env, id) {
  await env.THREADS_KV.delete(`office:${id}`);
  const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
  const ids = raw ? JSON.parse(raw) : [];
  await env.THREADS_KV.put(OFFICES_INDEX_KEY, JSON.stringify(ids.filter((x) => x !== id)));
}

// ---- accounts ----

export async function listAccounts(env) {
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)));
  return accounts.filter(Boolean).map((a) => stripSecret(JSON.parse(a)));
}

export async function getAccount(env, username) {
  const raw = await env.THREADS_KV.get(`account:${username.toLowerCase()}`);
  return raw ? JSON.parse(raw) : null;
}

function stripSecret(account) {
  const { salt, hash, iterations, ...rest } = account;
  return rest;
}

// role: "agent" | "admin". allowedBrands: array of brand names, or "all".
// Any field left `undefined` keeps its EXISTING value (patch semantics) —
// this matters a lot now that lightweight callers (e.g. just touching
// lastActiveAt, or just editing fullName/pid) shouldn't have to resend
// role/officeId/allowedBrands/password just to avoid wiping them out.
// `passwordChangedBy` is only meaningful when `password` is also given —
// the username of whoever triggered the change (their own, for
// self-service; the admin's, for an admin-driven reset).
export async function saveAccount(env, { username, password, passwordChangedBy, role, officeId, allowedBrands, fullName, pid }) {
  const key = username.toLowerCase();
  const existing = await getAccount(env, key);
  let salt = existing?.salt;
  let hash = existing?.hash;
  // Pre-existing accounts saved before this field existed are implicitly
  // the old iteration count — see the note above hashPassword().
  let iterations = existing?.iterations || PBKDF2_ITERATIONS_LEGACY_FALLBACK;
  let lastPasswordChange = existing?.lastPasswordChange || null;
  // Bumped on every password change so any already-issued session token
  // (see issueToken()/verifyToken() above) is invalidated the instant a
  // password changes — a browser holding an old token can no longer use
  // it, same guarantee the old "re-send the password every request"
  // design had for free.
  let tokenVersion = existing?.tokenVersion || 0;
  if (password) {
    const hashed = await hashPassword(password);
    salt = hashed.salt;
    hash = hashed.hash;
    iterations = hashed.iterations;
    lastPasswordChange = { at: new Date().toISOString(), by: passwordChangedBy || key };
    tokenVersion += 1;
  }
  if (!salt || !hash) throw new Error("A password is required for a new account.");

  const account = {
    username: key,
    salt,
    hash,
    iterations,
    tokenVersion,
    role: role !== undefined ? (VALID_ROLES.includes(role) ? role : "agent") : (existing?.role || "agent"),
    officeId: officeId !== undefined ? (officeId || null) : (existing?.officeId ?? null),
    allowedBrands: allowedBrands !== undefined
      ? (allowedBrands === "all" ? "all" : (Array.isArray(allowedBrands) ? allowedBrands : []))
      : (existing?.allowedBrands ?? []),
    fullName: fullName !== undefined ? fullName : (existing?.fullName || ""),
    pid: pid !== undefined ? pid : (existing?.pid || ""),
    lastActiveAt: existing?.lastActiveAt || null,
    lastPasswordChange,
    // Lock state is intentionally NOT a parameter of saveAccount() — it's
    // only ever touched by setAccountLocked() below (manual SuperAdmin
    // action, or the auto-lock triggers in api/auth/login.js), so a
    // routine profile-field save can never accidentally lock/unlock
    // someone as a side effect.
    locked: existing?.locked || false,
    lockedAt: existing?.lockedAt || null,
    lockedReason: existing?.lockedReason || null,
  };
  await env.THREADS_KV.put(`account:${key}`, JSON.stringify(account));
  if (!existing) {
    const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
    const usernames = raw ? JSON.parse(raw) : [];
    if (!usernames.includes(key)) {
      usernames.unshift(key);
      await env.THREADS_KV.put(ACCOUNTS_INDEX_KEY, JSON.stringify(usernames));
    }
  }
  return stripSecret(account);
}

// Dedicated lock/unlock — deliberately separate from saveAccount() (see
// note above) so this is the ONLY code path that ever changes lock
// state, whether triggered by a SuperAdmin's manual click or by one of
// the auto-lock triggers in api/auth/login.js (too many distinct
// unrecognized IPs in an hour, or too many consecutive wrong passwords).
export async function setAccountLocked(env, username, locked, reason) {
  const key = username.toLowerCase();
  const existing = await getAccount(env, key);
  if (!existing) return null;
  existing.locked = !!locked;
  existing.lockedAt = locked ? new Date().toISOString() : null;
  existing.lockedReason = locked ? (reason || "Locked") : null;
  // Bump on both lock AND unlock — a token issued before the lock should
  // never come back to life just because the account was later unlocked;
  // whoever unlocks it should get a fresh token via a real login.
  existing.tokenVersion = (existing.tokenVersion || 0) + 1;
  await env.THREADS_KV.put(`account:${key}`, JSON.stringify(existing));
  return stripSecret(existing);
}

export async function deleteAccount(env, username) {
  const key = username.toLowerCase();
  await env.THREADS_KV.delete(`account:${key}`);
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  await env.THREADS_KV.put(ACCOUNTS_INDEX_KEY, JSON.stringify(usernames.filter((u) => u !== key)));
}

// "Admin-or-above exists" — governs the original bootstrap window (create
// the very first admin-tier account with the BRAND_EDIT_PASSWORD).
export async function anyAdminExists(env) {
  const accounts = await listAccounts(env);
  return accounts.some((a) => rankOf(a.role) >= ROLE_RANK.admin);
}

// Governs the SuperAdmin self-promotion bootstrap (see authenticateStaff
// below) — once true, that path closes for good.
export async function anySuperAdminExists(env) {
  const accounts = await listAccounts(env);
  return accounts.some((a) => a.role === "superadmin");
}

// ---- request-time auth ----

export function requestIP(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

// Cheap "last seen" tracking — throttled to at most one KV write per
// account per 5 minutes, otherwise every single poll/request from every
// logged-in agent would each cost a write and blow through KV's free-tier
// daily write limit fast. This means Last Active Time in Agent Profile is
// "accurate to within ~5 minutes", not to-the-second — an acceptable
// trade for how it's actually used (spotting accounts that have gone
// quiet, not a real-time presence indicator).
async function touchLastActive(env, account) {
  const now = Date.now();
  const last = account.lastActiveAt ? new Date(account.lastActiveAt).getTime() : 0;
  if (now - last < 5 * 60 * 1000) return;
  const fresh = await getAccount(env, account.username);
  if (!fresh) return;
  fresh.lastActiveAt = new Date(now).toISOString();
  await env.THREADS_KV.put(`account:${account.username}`, JSON.stringify(fresh));
}

/**
 * Whether an account passes the office/IP check for a given request.
 * SuperAdmin is the ONE deliberate exception — every other role MUST be
 * bound to an office with a matching IP; an account with no officeId that
 * isn't SuperAdmin now fails this outright instead of silently skipping
 * the check. Shared by verifyRequest() (every protected endpoint) AND
 * auth/login.js (the login form itself, which can't just call
 * verifyRequest() since there's no verified identity yet at that point)
 * so the two can never drift out of sync with each other.
 */
export async function officeIpCheckPasses(env, account, request) {
  if (account.role === "superadmin") return true;
  if (!account.officeId) return false;
  const office = await getOffice(env, account.officeId);
  const ip = requestIP(request);
  return !!(office && office.allowedIPs.length && office.allowedIPs.includes(ip));
}

/**
 * Verifies the X-Agent-Token header on an incoming request: signature +
 * expiry (verifyToken()), AND that the token's tokenVersion still
 * matches the account's current one (rejects tokens issued before a
 * password change or a lock/unlock cycle), AND the office/IP rule.
 * Returns the (secret-stripped) account on success, or null on any
 * failure — callers should treat null as "not authorized" without
 * leaking which specific check failed.
 */
export async function verifyRequest(request, env) {
  if (!env.THREADS_KV) return null;
  const token = request.headers.get("X-Agent-Token");
  if (!token) return null;

  const payload = await verifyToken(env, token);
  if (!payload) return null;

  const account = await getAccount(env, payload.u);
  if (!account) return null;

  // Checked BEFORE anything else — a locked account should be rejected
  // on every single request, and a browser holding a still-unexpired
  // token from before the lock must not keep working.
  if (account.locked) return null;

  // A token from before the most recent password change / lock / unlock
  // is stale even if its signature and expiry are both still valid.
  if ((account.tokenVersion || 0) !== payload.v) return null;

  if (!(await officeIpCheckPasses(env, account, request))) return null;

  await touchLastActive(env, account);
  return stripSecret(account);
}

export function canSeeBrand(account, brandName) {
  if (rankOf(account.role) >= ROLE_RANK.admin) return true; // admin & superadmin see everything
  if (account.allowedBrands === "all") return true;
  return Array.isArray(account.allowedBrands) && account.allowedBrands.includes(brandName);
}

/**
 * Gate for the Account-Management endpoints, parameterized by minimum
 * role rank. Two ways in:
 *   1. A real logged-in account whose role rank >= minRank (X-Agent-Token).
 *   2. BOOTSTRAP MODE: if no admin-or-above account exists in KV yet at
 *      all, and minRank is admin or below, the existing
 *      BRAND_EDIT_PASSWORD secret works as a one-time key (sent as
 *      X-Bootstrap-Password) purely to let the business owner create the
 *      very first admin account. The instant one admin-or-above account
 *      exists, this fallback stops being accepted — it's not a
 *      permanent second door, just a way to get started.
 */
export async function authenticateStaff(request, env, minRank) {
  const viaAccount = await verifyRequest(request, env);
  if (viaAccount && rankOf(viaAccount.role) >= minRank) return { ok: true, account: viaAccount };

  // Bootstrap mode grants FULL trust (any minRank, including superadmin
  // operations like creating an Office) but ONLY while zero admin-or-above
  // accounts exist anywhere — that's the entire initial-setup window
  // (create the first Office, then the first admin account). The instant
  // one admin-or-above account exists, this fallback stops being accepted
  // for good, at any rank — it's not a permanent second door.
  const bootstrapPassword = request.headers.get("X-Bootstrap-Password");
  if (bootstrapPassword && env.BRAND_EDIT_PASSWORD && bootstrapPassword === env.BRAND_EDIT_PASSWORD) {
    const hasAdmin = await anyAdminExists(env);
    if (!hasAdmin) return { ok: true, account: null, bootstrap: true };
  }

  return { ok: false };
}

// Back-compat alias — deletion-log.js and anywhere else that only ever
// needs the "classic" admin-or-above gate can keep using this name.
export async function authenticateAdmin(request, env) {
  return authenticateStaff(request, env, ROLE_RANK.admin);
}
