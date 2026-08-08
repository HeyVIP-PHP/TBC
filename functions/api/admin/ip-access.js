/**
 * /api/admin/ip-access
 *
 * Backs the "IP Access" admin dashboard (5 cards: Total / Approved /
 * Pending / Blocked / Manually — see functions/_shared/ipAccess.js for
 * the full design note on how this layers on top of the existing
 * Office/allowedIPs whitelist without changing how a login is actually
 * checked).
 *
 *   GET                                    -> { stats, pending, approved, blocked, manual, record }
 *   POST { action:"approve", officeId, ip }
 *   POST { action:"reject",  officeId, ip }
 *   POST { action:"block",   ip, reason }
 *   POST { action:"unblock", ip }
 *   POST { action:"manualAdd", officeId, ip }
 *   POST { action:"remove",  officeId, ip }
 *
 * Gated by the SAME "whitelistIp" admin section as
 * functions/api/admin/offices.js (View for GET, Can-Edit for POST) —
 * this is the same feature area from the account-access-control point of
 * view, just a different admin page, so it reuses that section rather
 * than inventing a new one that an Owner would have to separately grant.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, getOffice, saveOffice, listOffices, setAccountLocked } from "../../_shared/accounts.js";
import { getIpAccessDashboard, approveIpRequest, rejectIpRequest, blockIp, unblockIp, addManualIp, removeApprovedIp } from "../../_shared/ipAccess.js";

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
  if (!canSeeAdminSection(auth.account, "whitelistIp")) return json({ ok: false, error: "You don't have access to IP Access." }, 403);

  const dashboard = await getIpAccessDashboard(env, { listOffices });
  return json({ ok: true, ...dashboard });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "whitelistIp")) return json({ ok: false, error: "You don't have Can-Edit access to IP Access." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // Bootstrap mode (auth.account === null) acting as the Owner for
  // attribution purposes, same convention used elsewhere for bootstrap.
  const by = auth.account ? auth.account.username : "bootstrap";
  const byRole = auth.account ? auth.account.role : "owner";

  const ip = (body.ip || "").trim();
  if (!ip) return json({ ok: false, error: "Missing IP address." }, 400);

  // Format check on every action that takes a raw, admin-typed IP
  // (manualAdd, block) — "approve"/"reject" always operate on an IP that
  // came from a real request's CF-Connecting-IP header (already a valid
  // address by construction), so they're exempt. This is the exact bug
  // class flagged during design review: without this check, something
  // like "https://203.189.67.234" pasted with a stray prefix gets stored
  // verbatim and silently never matches anything at login time.
  if ((body.action === "manualAdd" || body.action === "block") && !isValidIpFormat(ip)) {
    return json({ ok: false, error: `"${ip}" doesn't look like a valid IPv4 or IPv6 address.` }, 400);
  }

  try {
    switch (body.action) {
      case "approve": {
        if (!body.officeId) return json({ ok: false, error: "Missing officeId." }, 400);
        const result = await approveIpRequest(env, { officeId: body.officeId, ip, by, byRole, getOffice, saveOffice, setAccountLocked });
        return json({ ok: true, office: result.office });
      }
      case "reject": {
        if (!body.officeId) return json({ ok: false, error: "Missing officeId." }, 400);
        await rejectIpRequest(env, { officeId: body.officeId, ip, by, byRole });
        return json({ ok: true });
      }
      case "block": {
        await blockIp(env, { ip, reason: body.reason || "", by, byRole });
        return json({ ok: true });
      }
      case "unblock": {
        await unblockIp(env, { ip, by, byRole });
        return json({ ok: true });
      }
      case "manualAdd": {
        if (!body.officeId) return json({ ok: false, error: "Missing officeId." }, 400);
        const office = await addManualIp(env, { officeId: body.officeId, ip, by, byRole, getOffice, saveOffice });
        return json({ ok: true, office });
      }
      case "remove": {
        if (!body.officeId) return json({ ok: false, error: "Missing officeId." }, 400);
        await removeApprovedIp(env, { officeId: body.officeId, ip, by, byRole, getOffice, saveOffice });
        return json({ ok: true });
      }
      default:
        return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 400);
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/; // loose — full RFC 4291 validation isn't worth the complexity here

function isValidIpFormat(ip) {
  const m = ip.match(IPV4_RE);
  if (m) return m.slice(1).every((octet) => Number(octet) <= 255 && String(Number(octet)) === octet.replace(/^0+(?=\d)/, ""));
  return IPV6_RE.test(ip);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
