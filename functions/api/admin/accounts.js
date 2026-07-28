/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets).
 *     Requires rank >= senior (Senior needs this to pick a target for
 *     assisted password resets). NEVER includes "owner" accounts for
 *     anyone EXCEPT an owner viewing this list themselves, in which case
 *     they see their own row (and only their own) — see listAccounts()
 *     in _shared/accounts.js, filtered at the source.
 *   POST { action:"save", username, password?, role?, officeId?, allowedBrands?, allowedModules?, fullName?, pid? }
 *     What's allowed depends on the caller's rank AND the TARGET
 *     account's rank — see the permission matrix below. Any field
 *     omitted from the body keeps its existing value (saveAccount uses
 *     patch/merge semantics).
 *   POST { action:"delete", username }   -> requires rank >= admin, and
 *     scoped the same way as create/reset below.
 *   POST { action:"lock"|"unlock", username, reason? } -> requires rank
 *     >= superadmin (no delegation to Admin/Senior), AND target rank
 *     strictly below the caller's own. Manual override in either
 *     direction for the auto-lock feature in api/auth/login.js (5
 *     consecutive wrong passwords, or 5 different unrecognized IPs
 *     within an hour, both lock the account automatically) — see that
 *     file's header for the full writeup.
 *
 * Permission matrix (2026-07 redesign — added an "owner" tier above
 * superadmin; see PROJECT_STATUS.md "Role hierarchy" for the full
 * writeup). Every tier's authority is now governed by ONE rule instead
 * of a hand-maintained allow-list: an actor may create / assisted-
 * password-reset / delete / lock-unlock / edit-role-and-access-of a
 * target ONLY IF the actor's rank is STRICTLY GREATER than the target's
 * rank (see canManage() below). Same rank can never manage same rank —
 * this is what makes "SuperAdmin can't touch another SuperAdmin, only
 * Owner can" fall out for free, with no owner-specific special-casing
 * needed in the comparison itself.
 *   - "owner" itself can NEVER be created, promoted to, or edited
 *     through this endpoint (or through saveAccount() at all — see
 *     ASSIGNABLE_ROLES in _shared/accounts.js) — full stop, regardless
 *     of the caller's rank. The only way an owner account exists is a
 *     direct KV write outside the app.
 *   - Any request that names an EXISTING owner account as its target
 *     (save/delete/lock/unlock) gets back the exact same "Account not
 *     found" a nonexistent username would — never a permission-denied —
 *     so a SuperAdmin poking at a guessed username can't tell the
 *     difference between "doesn't exist" and "exists but I'm not allowed
 *     to touch it."
 *   - Editing role / officeId / allowedBrands / allowedModules on an
 *     EXISTING account: caller rank must be >= superadmin AND strictly
 *     greater than the target's rank — EXCEPT the one-time SuperAdmin
 *     self-promotion bootstrap (an admin-or-above promoting THEIR OWN
 *     account to "superadmin", only while no superadmin exists anywhere
 *     yet — unrelated to and unaffected by the owner tier).
 *   - Editing fullName / pid (profile fields) on an EXISTING account:
 *     caller rank >= admin AND (editing themselves OR strictly
 *     outranking the target).
 */
import { listAccounts, saveAccount, deleteAccount, getAccount, authenticateStaff, anySuperAdminExists, setAccountLocked, ROLE_RANK, rankOf, canSeeAdminSection, canEditAdminSection, canManageOthersAdminAccess } from "../../_shared/accounts.js";

// An actor may act on a target only if strictly outranking it — same
// rank can never manage same rank (this alone is what stops SuperAdmin
// from managing another SuperAdmin; Owner, one tier above, still can).
function canManage(actorRank, targetRank) {
  return actorRank > targetRank;
}

// True when `target` is a real, existing account whose role is "owner"
// AND the actor doesn't outrank it — i.e. every non-owner actor. Used to
// make owner accounts indistinguishable from nonexistent ones for any
// action targeting them by username (see the file header). Deliberately
// does NOT special-case "actor is also an owner" via a role check —
// rank comparison (owner is the top rank) already covers that correctly
// with no extra branching.
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
  // Only an owner viewing this list gets their OWN row back (see the
  // viewerUsername comment on listAccounts() in _shared/accounts.js) —
  // everyone else, at any rank, still sees zero owner accounts.
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

  // "owner" can never be the value of `role` in ANY save request —
  // creating a new account with it, or trying to promote an existing
  // account to it — regardless of the caller's own rank. This is also
  // enforced independently inside saveAccount() itself (see
  // ASSIGNABLE_ROLES in _shared/accounts.js); checked here too so the
  // rejection is explicit and immediate rather than a silent no-op deep
  // in a shared function.
  if (body.action === "save" && body.role === "owner") {
    return json({ ok: false, error: "The Owner role cannot be assigned through this interface." }, 403);
  }

  // canManageAdminAccess (whether an account can itself delegate Account
  // Management Access to OTHER accounts) can ONLY ever be flipped by an
  // Owner — this is the one flag in this whole system with no delegation
  // path, since letting a delegate re-delegate would create an
  // uncontrolled chain.
  if (body.action === "save" && body.canManageAdminAccess !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: "Only the account owner can grant or revoke delegated admin-access management." }, 403);
  }
  // allowedAdminSections / adminSectionEditAccess: Owner can touch
  // anyone; anyone else needs canManageOthersAdminAccess() (delegated via
  // the flag above).
  if (body.action === "save" && (body.allowedAdminSections !== undefined || body.adminSectionEditAccess !== undefined) && !canManageOthersAdminAccess(auth.account)) {
    return json({ ok: false, error: "You don't have permission to change Account Management Access." }, 403);
  }

  // Bootstrap mode (no real account yet) is treated as superadmin-rank
  // for this one-time setup call — same trust level BRAND_EDIT_PASSWORD
  // already had before any of this existed.
  const actorRank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.superadmin;
  const actorUsername = auth.account ? auth.account.username : null;

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    const targetUsername = body.username.toLowerCase();
    const existingTarget = await getAccount(env, targetUsername);

    // An owner account, targeted by anyone who doesn't outrank it (i.e.
    // everyone but another owner) — respond exactly as if it didn't
    // exist. See isHiddenTarget()'s comment above for why this can't
    // just be a 403.
    if (isHiddenTarget(existingTarget, actorRank)) {
      return json({ ok: false, error: "Account not found." }, 404);
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
      // Compare against the ACTUAL existing values, not just "was this
      // field present in the body" — accounts-admin.html's form always
      // resubmits every field (officeId, allowedBrands, fullName, pid)
      // whether or not the person actually touched it, so "field present"
      // would wrongly count as "changing" even when the value is
      // identical. This matters a lot for the SuperAdmin self-promotion
      // bootstrap below, which requires ONLY role to be changing.
      const targetRank = rankOf(existingTarget.role);
      const isSelf = actorUsername === targetUsername;
      const roleChanging = body.role !== undefined && body.role !== existingTarget.role;
      const profileChanging =
        (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) ||
        (body.pid !== undefined && body.pid !== (existingTarget.pid || ""));
      const accessChanging =
        (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) ||
        (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? [])) ||
        (body.allowedModules !== undefined && JSON.stringify(body.allowedModules) !== JSON.stringify(existingTarget.allowedModules ?? "all"));
      const passwordChanging = !!body.password;
      // Account Management Access itself (allowedAdminSections /
      // adminSectionEditAccess) — the top-level canManageOthersAdminAccess
      // gate above already confirmed the actor is allowed to touch ANYONE's
      // admin access; this adds the same "target must be strictly
      // outranked" scoping every other field here already has (Owner is
      // exempt, same as everywhere else).
      const adminSectionsChanging = body.allowedAdminSections !== undefined && JSON.stringify(body.allowedAdminSections) !== JSON.stringify(existingTarget.allowedAdminSections ?? []);
      const adminSectionEditAccessChanging = body.adminSectionEditAccess !== undefined && JSON.stringify(body.adminSectionEditAccess) !== JSON.stringify(existingTarget.adminSectionEditAccess ?? []);
      if ((adminSectionsChanging || adminSectionEditAccessChanging) && auth.account?.role !== "owner" && !canManage(actorRank, targetRank)) {
        return json({ ok: false, error: "You can only change Account Management Access for accounts ranked below your own." }, 403);
      }

      if (roleChanging || accessChanging) {
        const isSelfPromotionToSuperAdmin =
          isSelf &&
          body.role === "superadmin" &&
          !accessChanging &&
          actorRank >= ROLE_RANK.admin;
        const superAdminAlreadyExists = await anySuperAdminExists(env);
        // Replaces the old flat "actorRank >= ROLE_RANK.superadmin" floor
        // — role/office/brands/modules edits are now gated by the
        // per-account agentProfile Can-Edit grant instead of rank alone
        // (an Admin CAN be granted this; a SuperAdmin CAN be left without
        // it). The "must strictly outrank the TARGET" rule is separate and
        // still independently enforced via canManage() below — Can-Edit
        // never lets you reach a peer or superior.
        const hasAuthority = canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);

        if (!hasAuthority && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
          return json({ ok: false, error: "You can only change role, office, or access for accounts ranked below your own." }, 403);
        }
      }
      // Self-editing your own fullName/pid is a basic self-service
      // privilege (rank >= admin), unrelated to Account Management Access
      // — it was never gated by the old SuperAdmin floor either. Editing
      // SOMEONE ELSE'S profile fields now requires Can-Edit(agentProfile)
      // instead of the old flat "actorRank >= admin".
      const selfProfileOk = isSelf && actorRank >= ROLE_RANK.admin;
      const othersProfileOk = !isSelf && canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);
      if (profileChanging && !selfProfileOk && !othersProfileOk) {
        return json({ ok: false, error: "You can only edit profile fields for your own account, or accounts ranked below your own." }, 403);
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
        fullName: body.fullName !== undefined ? body.fullName : undefined,
        pid: body.pid !== undefined ? body.pid : undefined,
        allowedAdminSections: body.allowedAdminSections !== undefined ? body.allowedAdminSections : undefined,
        adminSectionEditAccess: body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : undefined,
        canManageAdminAccess: body.canManageAdminAccess !== undefined ? body.canManageAdminAccess : undefined,
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
    // Manual lock/unlock — was previously SuperAdmin-or-above only; now
    // gated by the same agentProfile Can-Edit grant as role/office/
    // brands/modules edits above (an Admin CAN be granted this, a
    // SuperAdmin CAN be left without it), AND the target must still be
    // strictly outranked by the caller (peer SuperAdmins still can't
    // touch each other; only Owner, or a delegate who outranks them,
    // can act on a SuperAdmin). Requested directly by the business owner
    // alongside the auto-lock triggers in api/auth/login.js — see that
    // file for what actually causes an automatic lock; this is just the
    // manual override either direction.
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
