/**
 * /api/admin/offices
 *   GET                                  -> list offices. Requires rank >= admin
 *     (Admin can SEE the IP whitelist for awareness, but not change it).
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update.
 *     Requires rank >= superadmin.
 *   POST { action:"delete", id }         -> delete. Requires rank >= superadmin.
 *
 * See _shared/accounts.js authenticateStaff() for the two ways in (real
 * login at the required rank, or the one-time bootstrap password).
 */
import { listOffices, saveOffice, deleteOffice, authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.admin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  return json({ ok: true, offices: await listOffices(env) });
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
  // Editing IPs is SuperAdmin-only — Admin can view via GET above but not
  // change the whitelist. The bootstrap password still works here during
  // initial setup (creating the very first Office before any admin
  // account exists) since authenticateStaff grants bootstrap mode full
  // trust until an admin-or-above account exists — see _shared/accounts.js.
  const auth = await authenticateStaff(request, env, ROLE_RANK.superadmin);
  if (!auth.ok) return json({ ok: false, error: "SuperAdmin required." }, 403);

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
