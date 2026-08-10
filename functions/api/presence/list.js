/**
 * /api/presence/list  (Active Agents online-status panel — roster)
 *
 *   GET -> { ok, agents: [{ username, status, lastActiveAt, lastDevice,
 *            todayOnlineMs }, ...] }
 *
 * Gated by canSeeAdminSection(account, "activeAgents") — same pattern
 * as every other Account-Management-Access section (whitelistIp,
 * agentProfile, ...). minRank mirrors the other view-gated sections
 * (senior+) — canSeeAdminSection() itself still deny-by-defaults every
 * rank below Owner unless explicitly granted, this is just the floor.
 *
 * OWNER DOUBLE-FILTER (defense in depth, per the migration doc §6):
 * listAccounts() already excludes the owner from anyone but the owner
 * themselves, but this endpoint filters `role !== "owner"` again
 * explicitly rather than trusting that single upstream filter — same
 * reasoning as list.js/record.js in the original ip-access dashboard:
 * two independent checks, not one.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, listAccounts, listOffices } from "../../_shared/accounts.js";
import { listPresence } from "../../_shared/presence.js";

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

  const [accounts, offices] = await Promise.all([
    listAccounts(env, { viewerUsername: auth.account.username }),
    listOffices(env),
  ]);
  const visibleAccounts = accounts.filter((a) => a.role !== "owner"); // defense in depth, see file header
  const officeNameById = new Map(offices.map((o) => [o.id, o.name]));

  const presence = await listPresence(env, visibleAccounts.map((a) => a.username));
  const presenceByUsername = new Map(presence.map((p) => [p.username, p]));

  const agents = visibleAccounts.map((a) => {
    const p = presenceByUsername.get(a.username.toLowerCase()) || {
      status: "offline", lastActiveAt: null, lastDevice: null, todayOnlineMs: 0,
    };
    return {
      username: a.username,
      fullName: a.fullName || "",
      role: a.role,
      officeName: a.officeId ? (officeNameById.get(a.officeId) || null) : null,
      status: p.status,
      lastActiveAt: p.lastActiveAt,
      device: p.lastDevice,
      todayOnlineMs: p.todayOnlineMs,
    };
  });

  agents.sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.username.localeCompare(b.username);
  });

  const onlineCount = agents.filter((a) => a.status === "online").length;

  return json({ ok: true, agents, onlineCount, totalCount: agents.length });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
