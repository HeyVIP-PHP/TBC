/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets).
 *     Requires rank >= senior (Senior needs this to pick a target for
 *     assisted password resets). Owner accounts are always omitted,
 *     except an owner viewing the list sees their own row.
 *   POST { action:"save", username, password?, role?, officeId?, allowedBrands?, allowedModules?, allowedAdminSections?, adminSectionEditAccess?, canManageAdminAccess?, fullName?, pid? }
 *     What's allowed depends on the caller's Can-Edit("agentProfile")
 *     status AND what's actually changing — see the permission matrix
 *     below. Any field omitted from the body keeps its existing value
 *     (saveAccount uses patch/merge semantics). role:"owner" is rejected
 *     outright — see OWNER_ROLE_SETUP.md for the only way to actually get
 *     an owner account (a direct KV write, not through this endpoint at
 *     all).
 *
 *     allowedAdminSections / adminSectionEditAccess / canManageAdminAccess
 *     ("Account Management Access", see canSeeAdminSection() /
 *     canEditAdminSection() in _shared/accounts.js) have their OWN rules,
 *     separate from the role/office/brands/modules matrix below:
 *       - canManageAdminAccess can ONLY ever be changed by the Owner.
 *       - allowedAdminSections / adminSectionEditAccess can be changed by
 *         the Owner (any target), or by anyone with
 *         canManageAdminAccess:true — but only for a target ranked
 *         strictly below them, same as everything else (they can't touch
 *         their own allowedAdminSections/adminSectionEditAccess).
 *   POST { action:"delete", username }   -> requires rank >= admin, and
 *     scoped the same way as create/reset below.
 *   POST { action:"lock"|"unlock", username, reason? } -> requires
 *     Can-Edit on "agentProfile" (see canEditAdminSection() — this
 *     COMPLETELY REPLACES the old rank>=superadmin floor, explicit
 *     business-owner decision) AND strictly outranking the target (so
 *     same-rank accounts still can't lock each other regardless of who
 *     has Can-Edit). Manual override in either direction for the
 *     auto-lock feature in api/auth/login.js (5 consecutive wrong
 *     passwords, or 5 different unrecognized IPs within an hour, both
 *     lock the account automatically) — see that file's header for the
 *     full writeup.
 *
 * Permission matrix (see OWNER_ROLE_SETUP.md for the full design
 * writeup) — ONE rule, not a hand-written allow-list per tier:
 *
 *   actor can only manage a target whose rank is STRICTLY LOWER than
 *   the actor's own rank (agent=0, senior=1, admin=2, superadmin=3,
 *   owner=4). Same rank can never manage same rank — a SuperAdmin
 *   cannot touch another SuperAdmin; only Owner can. This one rule
 *   governs creating an account with a given role, an assisted
 *   password-only reset targeting an existing account, deleting an
 *   account, and locking/unlocking an account (that last one ALSO still
 *   requires Can-Edit("agentProfile") on top of outranking the target).
 *   - Editing role / officeId / allowedBrands / allowedModules on an
 *     EXISTING account: Can-Edit("agentProfile") AND outranks the
 *     target — NOT a rank floor anymore (was rank>=superadmin; explicit
 *     business-owner decision to replace it with the per-account
 *     Can-Edit checkbox, see canEditAdminSection()) — EXCEPT the
 *     one-time SuperAdmin self-promotion bootstrap (an admin-or-above
 *     promoting THEIR OWN account to "superadmin", only while no
 *     superadmin exists anywhere yet).
 *   - Editing fullName / pid (profile fields) on your OWN account: still
 *     just requires rank >= admin (unrelated to Account Management
 *     Access — basic self-service, unchanged).
 *   - Editing fullName / pid on SOMEONE ELSE'S account: Can-Edit
 *     ("agentProfile") AND outranks the target — same replacement as
 *     role/office/brands/modules above.
 */
import { listAccounts, saveAccount, deleteAccount, getAccount, authenticateStaff, anySuperAdminExists, setAccountLocked, ROLE_RANK, rankOf, canSeeAdminSection, canEditAdminSection, canManageOthersAdminAccess } from "../../_shared/accounts.js";

// actor can only ever touch a STRICTLY lower rank — same rank can't
// manage same rank (two SuperAdmins can't touch each other; only Owner
// outranks SuperAdmin). See OWNER_ROLE_SETUP.md for the full reasoning.
function canManage(actorRank, targetRank) {
  return actorRank > targetRank;
}

// Owner accounts don't exist as far as anyone below Owner is concerned —
// a blocked target returns 404 ("Account not found"), never 403, so a
// non-owner can't even infer that a hidden account exists at that
// username by getting a different error code back.
function isHiddenTarget(target, actorRank) {
  return !!target && target.role === "owner" && actorRank < ROLE_RANK.owner;
}

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
  // Only pass a viewerUsername (letting that one row through the hidden
  // filter in listAccounts()) when the viewer IS an owner looking at
  // themselves — everyone else gets the fully-filtered list.
  const viewerUsername = auth.account?.role === "owner" ? auth.account.username : undefined;
  return json({ ok: true, accounts: await listAccounts(env, { viewerUsername }) });
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
  // already had before any of this existed. (Bootstrap mode can never
  // reach owner-rank — there's no such thing as a "no accounts yet"
  // state that should imply owner trust; superadmin is the intended
  // ceiling here.)
  const actorRank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.superadmin;
  const actorUsername = auth.account ? auth.account.username : null;

  // The Owner role can never be assigned through this interface, full
  // stop — checked before anything else below even looks at `body`, so
  // there's no code path (bootstrap mode, self-promotion, anything)
  // that could accidentally let it slip through. See OWNER_ROLE_SETUP.md
  // for the only real way to get an owner account.
  if (body.action === "save" && body.role === "owner") {
    return json({ ok: false, error: "The Owner role cannot be assigned through this interface." }, 403);
  }

  // canManageAdminAccess (the Account Management Access delegation flag
  // itself, not the sections list) is Owner-only to set, full stop — this
  // is what stops a delegated account from delegating further and
  // spiraling out from under the Owner. Checked before anything else
  // below, same spirit as the owner-role guard above.
  if (body.action === "save" && body.canManageAdminAccess !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: "Only the Owner can grant or revoke Account Management Access delegation." }, 403);
  }
  // allowedAdminSections: the actor needs delegation rights AT ALL (owner
  // or canManageAdminAccess:true) before we even look at which target
  // this is for — the per-target rank check happens further down, once
  // we know whether this is a create or an edit.
  if (body.action === "save" && body.allowedAdminSections !== undefined && !canManageOthersAdminAccess(auth.account)) {
    return json({ ok: false, error: "You don't have permission to change Account Management Access." }, 403);
  }
  // Same delegation gate for the View/Edit sub-choice (adminSectionEditAccess)
  // — granting Can-Edit on whitelistIp/tgRoutes/agentProfile is just as
  // sensitive as granting visibility, so it needs the same "actor has
  // delegation at all" check up front.
  if (body.action === "save" && body.adminSectionEditAccess !== undefined && !canManageOthersAdminAccess(auth.account)) {
    return json({ ok: false, error: "You don't have permission to change Account Management Access." }, 403);
  }

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    const targetUsername = body.username.toLowerCase();
    const existingTarget = await getAccount(env, targetUsername);

    if (isHiddenTarget(existingTarget, actorRank)) {
      return json({ ok: false, error: "Account not found." }, 404); // not 403 — see isHiddenTarget()
    }

    if (!existingTarget) {
      // ---- Creating a brand-new account ----
      if (!canSeeAdminSection(auth.account, "createAccount")) {
        return json({ ok: false, error: "You don't have access to Create Account." }, 403);
      }
      const requestedRole = body.role || "agent";
      if (!canManage(actorRank, rankOf(requestedRole))) {
        return json({ ok: false, error: "You can only create accounts with a role lower than your own." }, 403);
      }
    } else {
      // ---- Editing an existing account ----
      const targetRank = rankOf(existingTarget.role);
      // Compare against the ACTUAL existing values, not just "was this
      // field present in the body" — accounts-admin.html's form always
      // resubmits every field (officeId, allowedBrands, fullName, pid)
      // whether or not the person actually touched it, so "field present"
      // would wrongly count as "changing" even when the value is
      // identical. This matters a lot for the SuperAdmin self-promotion
      // bootstrap below, which requires ONLY role to be changing.
      const roleChanging = body.role !== undefined && body.role !== existingTarget.role;
      const isSelf = actorUsername === targetUsername;
      const profileChanging =
        (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) ||
        (body.pid !== undefined && body.pid !== (existingTarget.pid || ""));
      const accessChanging =
        (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) ||
        (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? [])) ||
        (body.allowedModules !== undefined && JSON.stringify(body.allowedModules) !== JSON.stringify(existingTarget.allowedModules ?? "all"));
      const adminSectionsChanging = body.allowedAdminSections !== undefined && JSON.stringify(body.allowedAdminSections) !== JSON.stringify(existingTarget.allowedAdminSections ?? []);
      const adminSectionEditAccessChanging = body.adminSectionEditAccess !== undefined && JSON.stringify(body.adminSectionEditAccess) !== JSON.stringify(existingTarget.adminSectionEditAccess ?? []);
      const passwordChanging = !!body.password;

      // roleChanging/accessChanging (role, office, brands, Topic Access)
      // now gated by canEditAdminSection(..., "agentProfile") instead of
      // a hard rank>=superadmin floor — Can-Edit on Agent Profile is a
      // per-account grant the Owner controls directly (see
      // EDITABLE_ADMIN_SECTIONS / canEditAdminSection() in
      // _shared/accounts.js), NOT tied to SuperAdmin rank anymore. The
      // "must strictly outrank the target" rule (canManage) is untouched
      // — that's a separate, still-active protection.
      if (roleChanging || accessChanging) {
        const isSelfPromotionToSuperAdmin =
          isSelf &&
          body.role === "superadmin" &&
          !accessChanging &&
          actorRank >= ROLE_RANK.admin;
        const superAdminAlreadyExists = await anySuperAdminExists(env);

        const hasAuthority = canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);
        if (!hasAuthority && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
          return json({ ok: false, error: "You can only change role, office, or access for accounts ranked below your own." }, 403);
        }
      }
      // allowedAdminSections/adminSectionEditAccess have their own
      // authority rule (checked for "does the actor have delegation at
      // all" further up already) — here we only need the per-TARGET
      // half: the Owner can touch anyone, a delegated non-Owner can only
      // touch a strictly-lower-ranked target (never themselves —
      // canManage(x,x) is false).
      if ((adminSectionsChanging || adminSectionEditAccessChanging) && auth.account?.role !== "owner" && !canManage(actorRank, targetRank)) {
        return json({ ok: false, error: "You can only change Account Management Access for accounts ranked below your own." }, 403);
      }
      // Agent Profile edits targeting someone ELSE (not the actor's own
      // account) additionally require the "agentProfile" section —
      // editing your OWN fullName/pid stays unrestricted self-service,
      // same as always.
      if ((profileChanging || roleChanging || accessChanging) && !isSelf && !canSeeAdminSection(auth.account, "agentProfile")) {
        return json({ ok: false, error: "You don't have access to Agent Profile." }, 403);
      }
      // Editing your OWN fullName/pid still just needs the pre-existing
      // admin-rank floor (unrelated to the Account Management Access
      // system — this is basic self-service, not an admin action).
      // Editing SOMEONE ELSE'S profile fields now requires Can-Edit on
      // "agentProfile" (not rank), same replacement as roleChanging/
      // accessChanging above, plus still needing to outrank the target.
      if (profileChanging) {
        const selfOk = isSelf && actorRank >= ROLE_RANK.admin;
        const othersOk = !isSelf && canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);
        if (!selfOk && !othersOk) {
          return json({ ok: false, error: "You can only edit profile fields for your own account, or accounts ranked below your own." }, 403);
        }
      }
      if (passwordChanging && !roleChanging && !accessChanging) {
        // Password-only change on someone else's account (an assisted reset).
        if (!isSelf && !canManage(actorRank, targetRank)) {
          return json({ ok: false, error: "You can only reset a password for accounts ranked below your own." }, 403);
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
        allowedModules: body.allowedModules !== undefined ? body.allowedModules : undefined,
        allowedAdminSections: body.allowedAdminSections !== undefined ? body.allowedAdminSections : undefined,
        adminSectionEditAccess: body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : undefined,
        canManageAdminAccess: body.canManageAdminAccess !== undefined ? body.canManageAdminAccess : undefined,
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
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (target && !canManage(actorRank, rankOf(target.role))) {
      return json({ ok: false, error: "You can only delete accounts ranked below your own." }, 403);
    }
    await deleteAccount(env, body.username);
    return json({ ok: true });
  }

  if (body.action === "lock" || body.action === "unlock") {
    // Manual lock/unlock — Can-Edit on "agentProfile" (see
    // canEditAdminSection() in _shared/accounts.js — replaces the old
    // rank>=superadmin floor, same as roleChanging/accessChanging
    // above) AND must outrank the target (so two accounts of equal rank
    // still can't lock each other — only someone who genuinely outranks
    // the target can, regardless of who has Can-Edit). Requested
    // directly by the business owner alongside the auto-lock triggers in
    // api/auth/login.js — see that file for what actually causes an
    // automatic lock; this is just the manual override either direction.
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (!target) return json({ ok: false, error: "Account not found." }, 404);
    if (!(canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, rankOf(target.role)))) {
      return json({ ok: false, error: "You can only lock or unlock accounts ranked below your own." }, 403);
    }
    const locked = body.action === "lock";
    const account = await setAccountLocked(env, body.username, locked, locked ? (body.reason || `Manually locked by ${actorUsername}`) : null);
    return json({ ok: true, account });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
