/**
 * POST /api/auth/login   body: { username, password }
 *
 * No server-side session store — this validates the credentials + the
 * office/IP rule (see _shared/accounts.js officeIpCheckPasses() — every
 * role except SuperAdmin must be bound to an office with a matching IP;
 * an account with no office is rejected outright now, not silently let
 * through). On success, issues a signed session token (issueToken() in
 * _shared/accounts.js) and returns it alongside the account's public
 * info (role, allowedBrands). The frontend stores ONLY this token
 * (never the password — see the SECURITY INCIDENT note in
 * _shared/accounts.js for why that changed) and re-sends it as
 * X-Agent-Token on every subsequent request; every protected endpoint
 * re-verifies the token's signature/expiry/version independently.
 *
 * ERROR MESSAGES — deliberately generic for username/password ("Wrong
 * username or password") since those two failures happen BEFORE we know
 * the credentials are real, and blending them avoids confirming to
 * whoever's typing whether a given username even exists. Once the
 * password has actually verified correctly, though, the ONLY thing left
 * that can fail is the office/IP rule — at that point whoever's logging
 * in has already proven they know a real password, so there's nothing
 * left to protect by staying vague, and a specific "your IP isn't
 * whitelisted for your office" message (with the actual IP, so an admin
 * can immediately go add it) is much more useful than the same generic
 * line. Requested directly by the business owner.
 *
 * LOGIN FAILURE ALERTS — business owner requested a Telegram alert on
 * EVERY failed login attempt, for all three failure kinds: wrong
 * password, unrecognized/unwhitelisted IP, and no office assigned.
 * Login is STILL BLOCKED exactly as before in all three cases — this
 * only adds visibility, it does not loosen access. Deliberately not
 * de-duplicated — the business owner wants to see how many times a
 * given account has tried, not just a one-time flag. A successful login
 * from an IP already on the approved list never alerts at all
 * (officeIpCheckPasses() passes, none of this fires).
 *
 * "No office assigned" (an admin setup gap — someone forgot to assign
 * this account an office) DOES get its own alert like the other two, but
 * is handled as its own early-return branch BEFORE the IP-check block,
 * and — unlike the other two — does NOT count toward the auto-lock
 * threshold below (see ACCOUNT AUTO-LOCK). Reasoning: an account with no
 * office WILL always fail the IP check no matter what IP it tries from,
 * so a legitimate agent who simply hasn't been assigned an office yet
 * could otherwise get auto-locked just for trying to log in a few times
 * while waiting on an admin — that's not the "suspicious activity" this
 * lock exists to catch. Alert: yes (owner wants visibility into this
 * too). Lock-counter: no.
 *
 * ACCOUNT AUTO-LOCK — also requested directly, then refined this session
 * per explicit business-owner feedback: ONE combined counter, not two
 * independent tracks. A wrong password and a correct-password-but-bad-IP
 * attempt both count as "a failed login" toward the SAME threshold, in
 * any mix — e.g. 2 wrong passwords + 3 unrecognized-IP rejections = 5,
 * locks. Repeated attempts from the very same IP count every time too
 * (the earlier two-separate-triggers version only counted DISTINCT IPs
 * for its IP-side trigger, which undercounted someone retrying from one
 * single unwhitelisted IP over and over — fixed).
 *   - 5 failed login attempts within a rolling 1-hour window (KV-stored
 *     timestamped list, pruned to the last hour on every check) locks
 *     the account (sets `locked: true` via setAccountLocked() in
 *     _shared/accounts.js — see that file for what locking actually does
 *     to every other endpoint, not just this one).
 *   - A genuinely successful login (right password AND office/IP check
 *     both pass) clears the counter immediately — only an unbroken
 *     WINDOW of failures counts, not lifetime attempts.
 *   - "No office assigned" (see above) never touches this counter at
 *     all, in either direction — it still gets its own alert, just not
 *     lock-counted.
 * Once locked, the account can't log in (or use any already-open browser
 * session — see verifyRequest() in _shared/accounts.js) until a
 * SuperAdmin manually unlocks it (accounts-admin.html, or Agent Profile
 * on the Home sidebar). A separate Telegram alert fires the moment an
 * account gets auto-locked, distinct from the per-attempt IP-warning
 * message above.
 *
 * NOT YET CONFIGURED (as Cloudflare secrets): set SECURITY_ALERTS_CHAT_ID
 * (and optionally SECURITY_ALERTS_TOPIC_ID) as Cloudflare environment
 * variables as a fallback default — until then this silently no-ops
 * (sendTelegramMessage() skips cleanly with no chat ID). These CAN also
 * be set live from the browser instead — see the "Security Alerts" row
 * on the TG Group / Channel admin page (functions/api/admin/routes.js),
 * which resolveSecurityAlertsRoute() below checks first and takes
 * priority over these env vars the moment it's been saved once.
 */
import { getAccount, verifyPassword, officeIpCheckPasses, getOffice, requestIP, setAccountLocked, issueToken } from "../../_shared/accounts.js";
import { sendTelegramMessage } from "../../_shared/telegram.js";
import { getRouteOverride } from "../../_shared/routes.js";

// Reserved pseudo brand/module id pair — NOT a real brand — used so the
// "TG Group / Channel" admin page (functions/api/admin/routes.js) can
// let a SuperAdmin change where these alerts go live from the browser,
// reusing the exact same KV-override machinery every real brand+module
// route uses. Falls back to the SECURITY_ALERTS_CHAT_ID/
// SECURITY_ALERTS_TOPIC_ID Cloudflare secrets when nothing's been saved
// through that page yet.
async function resolveSecurityAlertsRoute(env) {
  const override = await getRouteOverride(env, "_security", "alerts");
  if (override) return override;
  return { chatId: env.SECURITY_ALERTS_CHAT_ID, topicId: env.SECURITY_ALERTS_TOPIC_ID };
}

const LOGIN_FAIL_LOCK_THRESHOLD = 5;
const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function onRequestPost(context) {
  try {
    return await handleLogin(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleLogin({ request, env, waitUntil }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return json({ ok: false, error: "Username and password are required." }, 400);

  const badCreds = () => json({ ok: false, error: "Wrong username or password." }, 401);

  const account = await getAccount(env, username);
  if (!account) return badCreds();

  // Checked before the (CPU-costly) password hash — see the matching
  // note in verifyRequest() in _shared/accounts.js.
  if (account.locked) {
    return json({ ok: false, error: `This account is locked${account.lockedReason ? ` (${account.lockedReason})` : ""}. Contact a SuperAdmin to unlock it.` }, 403);
  }

  const passwordOk = await verifyPassword(password, account.salt, account.hash, account.iterations);
  if (!passwordOk) {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "Wrong Password" }));
    const { locked, count } = await recordLoginFailure(env, account.username, { kind: "wrong password" });
    if (locked && waitUntil) {
      waitUntil(notifyAccountLocked(env, { account, reason: `${count} failed login attempts within the last hour` }));
    }
    return badCreds();
  }

  // "No office assigned" is an admin setup gap, not suspicious behavior —
  // still worth an alert (business owner wants visibility into ALL three
  // failure kinds), but handled as its own early branch, completely
  // separate from the LOCK-counting machinery below. An account with no
  // office WILL always fail officeIpCheckPasses() no matter what IP it
  // tries from, so counting it toward the same 5-in-an-hour lock
  // threshold as genuine wrong-password/bad-IP attempts would mean a
  // perfectly legitimate agent — who's done nothing wrong except not
  // being assigned an office yet — could get auto-locked just for
  // trying to log in a few times while waiting on an admin. So: alert
  // yes, lock-counter no.
  if (!account.officeId && account.role !== "superadmin") {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "No Office Assigned" }));
    return json({ ok: false, error: `Your account has no office assigned, so it can't log in from anywhere. Ask an admin to assign you an office (your current IP: ${ip}).` }, 401);
  }

  if (!(await officeIpCheckPasses(env, account, request))) {
    const ip = requestIP(request) || "unknown";
    // Fire-and-forget via waitUntil — never adds latency to the actual
    // rejection response, and a Telegram hiccup here can't turn into a
    // broken login flow (notifyLoginFailure swallows its own errors).
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "Abnormal IP Address" }));

    const { locked, count } = await recordLoginFailure(env, account.username, { kind: "unrecognized IP", ip });
    if (locked && waitUntil) {
      waitUntil(notifyAccountLocked(env, { account, reason: `${count} failed login attempts within the last hour` }));
    }

    const office = await getOffice(env, account.officeId);
    const officeName = office?.name || "your office";
    return json({ ok: false, error: `Your IP address (${ip}) isn't on the approved list for ${officeName}. Ask an admin to whitelist it under Account Management → Whitelist IP.` }, 401);
  }

  // Fully successful login (right password AND office/IP check passed) —
  // whatever failed-attempt history existed before this is over; don't
  // let it carry forward toward a future lockout.
  await clearLoginFailures(env, account.username);

  const token = await issueToken(env, account);
  return json({
    ok: true,
    token,
    account: { username: account.username, role: account.role, allowedBrands: account.allowedBrands, officeId: account.officeId },
  });
}

// ---- unified failed-login tracking (single trigger for auto-lock) ----
//
// Business owner wants ONE combined counter, not two independent tracks
// — a wrong password and a correct-password-but-bad-IP attempt both
// count as "a failed login" toward the same 5-in-an-hour threshold, in
// ANY mix/order. This also deliberately counts REPEATED attempts from
// the very same IP (earlier version of this only counted DISTINCT IPs
// toward the IP-side trigger — that undercounted a determined attacker
// retrying from one single unwhitelisted IP over and over). Rolling
// 1-hour window, same as before — old failures age out rather than
// haunting the account forever; a genuinely successful login also
// clears the slate immediately (see clearLoginFailures() below).
async function recordLoginFailure(env, username, { kind, ip }) {
  const key = `loginfail:${username}`;
  const raw = await env.THREADS_KV.get(key);
  const now = Date.now();
  let entries = raw ? JSON.parse(raw) : [];
  entries = entries.filter((e) => now - e.ts < LOGIN_FAIL_WINDOW_MS);
  entries.push({ kind, ip, ts: now });
  entries = entries.slice(-100); // defensive cap, well above what 1 hour of real attempts would ever produce
  const count = entries.length;

  if (count >= LOGIN_FAIL_LOCK_THRESHOLD) {
    await setAccountLocked(env, username, true, `${count} failed login attempts within 1 hour`);
    await env.THREADS_KV.delete(key); // fresh count if this account is ever unlocked and tried again
    return { locked: true, count };
  }
  await env.THREADS_KV.put(key, JSON.stringify(entries));
  return { locked: false, count };
}

async function clearLoginFailures(env, username) {
  await env.THREADS_KV.delete(`loginfail:${username}`).catch(() => {});
}

async function notifyAccountLocked(env, { account, reason }) {
  try {
    const lines = [
      `🔒<b>Account Auto-Locked</b>🔒`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `📋 Reason: ${escapeHtml(reason)}`,
      `🕒 Colombo Time: ${formatInZone(new Date(), "Asia/Colombo")} (GMT+5:30)`,
      ``,
      `🔑 This account can no longer log in (or use any already-open session) until a SuperAdmin unlocks it under Account Management → Agent Profile, or accounts-admin.html.`,
    ];
    const route = await resolveSecurityAlertsRoute(env);
    await sendTelegramMessage(env, {
      chatId: route.chatId,
      topicId: route.topicId,
      text: lines.join("\n"),
    });
  } catch {
    // Never let a notification hiccup affect anything else.
  }
}

// Sends an immediate per-attempt Telegram warning for ANY kind of failed
// login — wrong password, unrecognized/unwhitelisted IP, or no office
// assigned. All three are visible to the business owner this way, even
// though only "wrong password" and "unrecognized IP" count toward the
// combined 5-in-an-hour auto-lock threshold (see recordLoginFailure) —
// "no office assigned" is an admin setup gap, not suspicious behavior,
// so it's excluded from the LOCK counter but still worth a heads-up
// alert like the other two, per explicit business-owner request.
async function notifyLoginFailure(env, { account, ip, request, reasonTitle }) {
  try {
    const userAgent = request.headers.get("User-Agent") || "unknown device";
    const officeName = account.officeId ? (await getOffice(env, account.officeId))?.name : null;

    // Cloudflare attaches geo/network info to every request at the edge —
    // no extra API call needed, this is instant. `cf` can be missing in
    // local/dev environments, so every field below falls back cleanly.
    const cf = request.cf || {};
    const country = countryName(cf.country);
    const city = cf.city || "Unknown";
    const isp = cf.asOrganization || "Unknown";

    const now = new Date();
    const lines = [
      `⚠️<b>Login Warning (${escapeHtml(reasonTitle)})</b>⚠️`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `🌐 IP: ${escapeHtml(ip)}`,
      `🏢 Assigned office: ${escapeHtml(officeName || "none")}`,
      `📱 Browser/device: ${escapeHtml(userAgent)}`,
      `🗺️ Country: ${escapeHtml(country)}`,
      `🏙️ City: ${escapeHtml(city)}`,
      `📡 ISP: ${escapeHtml(isp)}`,
      `🕒 Colombo Time: ${formatInZone(now, "Asia/Colombo")} (GMT+5:30)`,
      `🕗 Malaysia Time: ${formatInZone(now, "Asia/Kuala_Lumpur")} (GMT+8:00)`,
      ``,
      `🚫 Login was blocked as usual — this is just a heads-up.`,
    ];
    const route = await resolveSecurityAlertsRoute(env);
    await sendTelegramMessage(env, {
      chatId: route.chatId,
      topicId: route.topicId,
      text: lines.join("\n"),
    });
  } catch {
    // Never let a notification hiccup affect anything else — this
    // function's caller is a fire-and-forget waitUntil() anyway.
  }
}

// Cloudflare's `cf.country` is a 2-letter code (e.g. "LK", "MY") — spell
// it out for a human reading a Telegram alert. Falls back to the raw
// code if Intl.DisplayNames can't resolve it (or isn't available) rather
// than showing nothing.
function countryName(code) {
  if (!code) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

// "2026-07-19 18:32" in the given IANA timezone — the (GMT+X) label is
// added by the caller as a static string rather than computed here,
// since the two zones this is used for (Colombo, Kuala Lumpur) don't
// observe daylight saving, so their offset never changes.
function formatInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return date.toISOString();
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
