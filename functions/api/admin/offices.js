/**
 * /api/admin/offices
 *   GET                                  -> list offices.
 *     This endpoint does double duty and its access rule reflects that:
 *       (a) the actual Whitelist IP admin page — full office objects
 *           (name + allowedIPs). Gated purely by the "whitelistIp"
 *           Account Management Access section — rank plays NO role here
 *           (explicit business-owner decision, see handlePost() below
 *           for the matching Can-Edit replacement).
 *       (b) the office picker inside Create Account / Agent Profile —
 *           those need SOME office list to assign/reassign an account's
 *           office, but neither should require full Whitelist IP access
 *           just to see office NAMES. So a caller with "createAccount"
 *           (rank >= senior, matching that section's own sidebar floor)
 *           or "agentProfile" (rank >= admin, ditto — this one section
 *           still keeps its own rank floor since it isn't part of the
 *           View/Edit-replaces-rank change) gets office id+name ONLY —
 *           never allowedIPs, which stays exclusively behind
 *           "whitelistIp". See canSeeAdminSection() in _shared/accounts.js.
 *     BUG FIX (see ACCOUNT_MGMT_ACCESS_AND_LABELS_SETUP.md discussion):
 *     originally this whole endpoint was hard-gated to rank >= admin AND
 *     "whitelistIp", which meant an account granted ONLY "createAccount"
 *     (no "whitelistIp") could open Create Account but the Office
 *     dropdown would always come back empty — and a Senior-rank account
 *     (which the sidebar already allows for "createAccount") would be
 *     rejected by the rank floor before the section check even ran.
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update.
 *     Requires Can-Edit on "whitelistIp" (see canEditAdminSection() in
 *     _shared/accounts.js) — NOT rank>=superadmin anymore, see
 *     handlePost() below for the full explanation.
 *   POST { action:"delete", id }         -> delete. Same Can-Edit gate.
 *
 * See _shared/accounts.js authenticateStaff() for the two ways in (real
 * login at the required rank, or the one-time bootstrap password).
 */
import { listOffices, saveOffice, deleteOffice, authenticateStaff, ROLE_RANK, rankOf, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  // Lowest floor among the sections that can legitimately hit this
  // endpoint is "createAccount"'s own (senior) — see the header comment.
  // Which FIELDS actually come back is still decided per-section below;
  // this first check is only "are you allowed in the door at all".
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  // Bootstrap mode (auth.account === null) is fully trusted, same as
  // everywhere else canSeeAdminSection()/rankOf() bootstrap-bypass — see
  // _shared/accounts.js. Give it the OWNER rank for the comparisons
  // below so both the full-whitelist and the name-only branches pass.
  const rank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.owner;

  // Full whitelist data (with allowedIPs) is now gated purely by the
  // "whitelistIp" checkbox — rank plays no role here anymore (see the
  // Can-Edit note in handlePost() below for the same replacement).
  const canSeeWhitelist = canSeeAdminSection(auth.account, "whitelistIp");
  const canPickOffice =
    canSeeWhitelist ||
    (rank >= ROLE_RANK.senior && canSeeAdminSection(auth.account, "createAccount")) ||
    (rank >= ROLE_RANK.admin && canSeeAdminSection(auth.account, "agentProfile"));

  if (!canPickOffice) return json({ ok: false, error: "You don't have access to IP Access." }, 403);

  const offices = await listOffices(env);
  // Only an actual "whitelistIp" holder gets allowedIPs back — everyone
  // else who's here just for the office picker gets id+name, which is
  // all a <select> needs and never leaks the whitelist data itself.
  const payload = canSeeWhitelist ? offices : offices.map(({ id, name }) => ({ id, name }));
  return json({ ok: true, offices: payload });
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
  // Editing IPs now requires Can-Edit on "whitelistIp" (see
  // canEditAdminSection() in _shared/accounts.js) — this COMPLETELY
  // REPLACES the old rank>=superadmin floor (explicit business-owner
  // decision): an Admin-rank account can be granted Can-Edit here, and a
  // SuperAdmin can be left at View-only if the Owner doesn't grant it.
  // Only the base staff-auth floor (senior, matching the lowest rank
  // that can reach any of these 3 sections at all) remains rank-based.
  // The bootstrap password still works here during initial setup
  // (creating the very first Office before any admin account exists)
  // since authenticateStaff grants bootstrap mode full trust until an
  // admin-or-above account exists, and canEditAdminSection() treats
  // bootstrap (account === null) as fully trusted too — see
  // _shared/accounts.js.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "whitelistIp")) return json({ ok: false, error: "You don't have Can-Edit access to IP Access." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    if (!body.name) return json({ ok: false, error: "Office name is required." }, 400);
    const office = await saveOffice(env, { id: body.id, name: body.name, allowedIPs: body.allowedIPs || [] });
    return json({ ok: true, office });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing office id." }, 400);
    await deleteOffice(env, body.id);
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
