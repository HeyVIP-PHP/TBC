/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets).
 *     Requires rank >= senior (Senior needs this to pick a target for
 *     assisted password resets).
 *   POST { action:"save", username, password?, role?, officeId?, allowedBrands?, fullName?, pid? }
 *     What's allowed depends on the caller's rank AND what's actually
 *     changing — see the permission matrix below. Any field omitted from
 *     the body keeps its existing value (saveAccount uses patch/merge
 *     semantics).
 *   POST { action:"delete", username }   -> requires rank >= admin, and
 *     scoped the same way as create/reset below.
 *   POST { action:"lock"|"unlock", username, reason? } -> SuperAdmin ONLY,
 *     no delegation to Admin/Senior (unlike everything else in this
 *     file). Manual override in either direction for the auto-lock
 *     feature in api/auth/login.js (5 consecutive wrong passwords, or 5
 *     different unrecognized IPs within an hour, both lock the account
 *     automatically) — see that file's header for the full writeup.
 *
 * Permission matrix (see PROJECT_STATUS.md "Role hierarchy" for the
 * full writeup) — each tier's "manage scope" is a literal allow-list,
 * NOT "anything ranked below me":
 *   - Senior's manage scope: Agent only.
 *   - Admin's manage scope: Agent AND Senior.
 *   - SuperAdmin: unrestricted.
 *   Manage scope governs THREE actions identically: creating a new
 *   account with that role, an assisted password-only reset targeting
 *   an existing account with that role, and deleting an account with
 *   that role.
 *   - Editing role / officeId / allowedBrands on an EXISTING account:
 *     SuperAdmin only — EXCEPT the one-time SuperAdmin self-promotion
 *     bootstrap (an admin-or-above promoting THEIR OWN account to
 *     "superadmin", only while no superadmin exists anywhere yet).
 *   - Editing fullName / pid (profile fields) on an EXISTING account:
 *     rank >= admin (Admin and SuperAdmin both allowed — Senior is not).
 */
import { listAccounts, saveAccount, deleteAccount, getAccount, authenticateStaff, anySuperAdminExists, setAccountLocked, ROLE_RANK, rankOf } from "../../_shared/accounts.js";

// Literal allow-lists, not a rank comparison — see file header.
const MANAGE_SCOPE = {
  senior: ["agent"],
  admin: ["agent", "senior"],
};

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
  return json({ ok: true, accounts: await listAccounts(env) });
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

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // Bootstrap mode (no real account yet) is treated as superadmin-rank
  // for this one-time setup call — same trust level BRAND_EDIT_PASSWORD
  // already had before any of this existed.
  const actorRank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.superadmin;
  const actorRole = auth.account ? auth.account.role : "superadmin";
  const actorUsername = auth.account ? auth.account.username : null;
  const inScope = (targetRole) => actorRank === ROLE_RANK.superadmin || (MANAGE_SCOPE[actorRole] || []).includes(targetRole);

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    const targetUsername = body.username.toLowerCase();
    const existingTarget = await getAccount(env, targetUsername);

    if (!existingTarget) {
      // ---- Creating a brand-new account ----
      const requestedRole = body.role || "agent";
      if (!inScope(requestedRole)) {
        return json({ ok: false, error: `You can only create accounts with role: ${(MANAGE_SCOPE[actorRole] || []).join(" or ")}.` }, 403);
      }
    } else {
      // ---- Editing an existing account ----
      // Compare against the ACTUAL existing values, not just "was this
      // field present in the body" — accounts-admin.html's form always
      // resubmits every field (officeId, allowedBrands, fullName, pid)
      // whether or not the person actually touched it, so "field present"
      // would wrongly count as "changing" even when the value is
      // identical. This matters a lot for the SuperAdmin self-promotion
      // bootstrap below, which requires ONLY role to be changing.
      const roleChanging = body.role !== undefined && body.role !== existingTarget.role;
      const profileChanging =
        (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) ||
        (body.pid !== undefined && body.pid !== (existingTarget.pid || ""));
      const accessChanging =
        (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) ||
        (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? []));
      const passwordChanging = !!body.password;

      if (roleChanging || accessChanging) {
        const isSelfPromotionToSuperAdmin =
          actorUsername === targetUsername &&
          body.role === "superadmin" &&
          !accessChanging &&
          actorRank >= ROLE_RANK.admin;
        const superAdminAlreadyExists = await anySuperAdminExists(env);

        if (actorRank < ROLE_RANK.superadmin && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
          return json({ ok: false, error: "Only SuperAdmin can change role, office, or brand access." }, 403);
        }
      }
      if (profileChanging && actorRank < ROLE_RANK.admin) {
        return json({ ok: false, error: "Only Admin or above can edit profile fields." }, 403);
      }
      if (passwordChanging && !roleChanging && !accessChanging) {
        // Password-only change on someone else's account (an assisted reset).
        if (!inScope(existingTarget.role)) {
          return json({ ok: false, error: `You can only reset a password for: ${(MANAGE_SCOPE[actorRole] || []).join(" or ")}.` }, 403);
        }
      }
    }

    try {
      const account = await saveAccount(env, {
        username: body.username,
        password: body.password || undefined,
        passwordChangedBy: body.password ? (actorUsername || "bootstrap-setup") : undefined,
        role: body.role !== undefined ? body.role : undefined,
        officeId: body.officeId !== undefined ? (body.officeId || null) : undefined,
        allowedBrands: body.allowedBrands !== undefined ? body.allowedBrands : undefined,
        fullName: body.fullName !== undefined ? body.fullName : undefined,
        pid: body.pid !== undefined ? body.pid : undefined,
      });
      return json({ ok: true, account });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (actorRank < ROLE_RANK.admin) return json({ ok: false, error: "Not authorized." }, 403); // Senior has no delete access at all
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (target && !inScope(target.role)) {
      return json({ ok: false, error: `You can only delete: ${(MANAGE_SCOPE[actorRole] || []).join(" or ")}.` }, 403);
    }
    await deleteAccount(env, body.username);
    return json({ ok: true });
  }

  if (body.action === "lock" || body.action === "unlock") {
    // Manual lock/unlock — SuperAdmin only, no exceptions (unlike
    // delete/create which follow the tiered MANAGE_SCOPE allow-list,
    // locking someone out of the whole hub is treated as sensitive
    // enough to not delegate down to Admin). Requested directly by the
    // business owner alongside the auto-lock triggers in
    // api/auth/login.js — see that file for what actually causes an
    // automatic lock; this is just the manual override either direction.
    if (actorRank < ROLE_RANK.superadmin) return json({ ok: false, error: "Only SuperAdmin can lock or unlock an account." }, 403);
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (!target) return json({ ok: false, error: "Account not found." }, 404);
    const locked = body.action === "lock";
    const account = await setAccountLocked(env, body.username, locked, locked ? (body.reason || `Manually locked by ${actorUsername}`) : null);
    return json({ ok: true, account });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
