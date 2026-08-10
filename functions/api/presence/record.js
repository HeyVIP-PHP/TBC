/**
 * /api/presence/record?username=<u>&days=<n>  (Active Agents — "Record")
 *
 *   GET -> { ok, username, days: [{ date, totalOnlineMs, lastActiveAt }, ...] }
 *
 * Same gate as list.js (canSeeAdminSection(account, "activeAgents")),
 * plus the same owner double-filter — a caller cannot pull the owner's
 * record even by guessing their username directly.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, getAccount } from "../../_shared/accounts.js";
import { getDailyRecord, listPresence } from "../../_shared/presence.js";

const MAX_DAYS = 31;
const DEFAULT_DAYS = 14;

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);

  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "activeAgents")) {
    return json({ ok: false, error: "You don't have access to Active Agents." }, 403);
  }

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") || "").trim();
  if (!username) return json({ ok: false, error: "username is required." }, 400);

  const target = await getAccount(env, username);
  if (!target || target.role === "owner") {
    // Same message for "doesn't exist" and "is the owner" — don't leak
    // which one it was.
    return json({ ok: false, error: "Agent not found." }, 404);
  }

  let days = parseInt(url.searchParams.get("days") || String(DEFAULT_DAYS), 10);
  if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
  if (days > MAX_DAYS) days = MAX_DAYS;

  const record = await getDailyRecord(env, target.username, days);
  const [current] = await listPresence(env, [target.username]);

  return json({
    ok: true,
    username: target.username,
    fullName: target.fullName || "",
    status: current.status,
    lastActiveAt: current.lastActiveAt,
    todayOnlineMs: current.todayOnlineMs,
    days: record,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
