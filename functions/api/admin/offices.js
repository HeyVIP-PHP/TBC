/**
 * /api/admin/offices
 *   GET                                  -> list offices.
 *     Base auth floor is Senior (the lowest of the sections that need an
 *     office list — Create Account needs the office dropdown too). Two
 *     data tiers on top of that: an actor with canSeeAdminSection(...,
 *     "whitelistIp") gets the full record (name + allowedIPs); anyone
 *     else (e.g. Senior/Admin who only has createAccount access) gets
 *     just { id, name } — enough to populate an office picker without
 *     leaking the IP whitelist to someone who has no whitelistIp access
 *     at all. (Bugfix, 2026-07: this endpoint used to hard-require
 *     whitelistIp access for the GET entirely, which meant an account
 *     with ONLY createAccount access couldn't see any offices and so
 *     couldn't pick one when creating a new account.)
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update.
 *     Requires Can-Edit(whitelistIp).
 *   POST { action:"delete", id }         -> delete. Requires Can-Edit(whitelistIp).
 *
 * See _shared/accounts.js authenticateStaff() for the two ways in (real
 * login at the required rank, or the one-time bootstrap password), and
 * canSeeAdminSection()/canEditAdminSection() for the per-account
 * Account Management Access layer these checks are built on.
 */
import { listOffices, saveOffice, deleteOffice, authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  // Lowest floor among the sections that need an office list at all —
  // "can I even get in the door" is separate from "how much data do I
  // get back", handled below.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  const offices = await listOffices(env);
  if (canSeeAdminSection(auth.account, "whitelistIp")) {
    return json({ ok: true, offices });
  }
  // Minimal shape for anyone who can reach this endpoint (e.g. via
  // createAccount access) but has no whitelistIp access — enough to
  // populate an office <select>, nothing about the IP whitelist itself.
  return json({ ok: true, offices: offices.map((o) => ({ id: o.id, name: o.name })) });
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
  if (!canEditAdminSection(auth.account, "whitelistIp")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Whitelist IP." }, 403);
  }

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
