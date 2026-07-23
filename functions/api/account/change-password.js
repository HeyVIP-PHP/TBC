/**
 * POST /api/account/change-password
 * body: { currentPassword, newPassword }
 *
 * Self-service only — an account can change ONLY its own password, never
 * anyone else's (that's what /api/admin/accounts is for, admin-gated).
 * Two independent proofs of identity are required, not one:
 *   1. The request's own X-Agent-Token header (the account is already
 *      logged in — verifyRequest() re-checks the token's signature,
 *      expiry, tokenVersion, and IP).
 *   2. The `currentPassword` field in the body, checked again explicitly
 *      here. Slightly redundant with #1 on paper, but it's a deliberate
 *      UX/safety net: a browser left logged in and unattended can still
 *      auto-attach valid headers, so re-typing the current password in
 *      the form itself is what actually stops someone else at the same
 *      desk from silently taking over the account by changing its
 *      password out from under the real owner.
 */
import { verifyRequest, getAccount, verifyPassword, saveAccount, issueToken } from "../../_shared/accounts.js";

export async function onRequestPost(context) {
  try {
    return await handleChangePassword(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleChangePassword({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const authed = await verifyRequest(request, env);
  if (!authed) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { currentPassword, newPassword } = body || {};
  if (!currentPassword || !newPassword) {
    return json({ ok: false, error: "Current and new password are both required." }, 400);
  }
  if (newPassword.length < 4) {
    return json({ ok: false, error: "New password is too short." }, 400);
  }

  // Re-fetch the full record (verifyRequest's return value has salt/hash
  // stripped) to check the explicitly-typed current password.
  const full = await getAccount(env, authed.username);
  if (!full) return json({ ok: false, error: "Account not found." }, 404);

  const currentOk = await verifyPassword(currentPassword, full.salt, full.hash, full.iterations);
  if (!currentOk) return json({ ok: false, error: "Current password is incorrect." }, 403);

  const updated = await saveAccount(env, {
    username: full.username,
    password: newPassword,
    passwordChangedBy: full.username, // self-service — always their own name
    role: full.role,
    officeId: full.officeId,
    allowedBrands: full.allowedBrands,
  });

  // The password change just bumped tokenVersion, which means the token
  // this very request came in on is now stale (see verifyRequest()) —
  // issue a fresh one immediately so the browser doesn't get logged out
  // right after successfully proving who it is.
  const token = await issueToken(env, updated);
  return json({ ok: true, token });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
