/**
 * GET /api/feature-status  -> { ok, items: { <itemId>: { status, blocked } } }
 *
 * Any logged-in account can call this (not gated behind the "settings"
 * Account Management section — every agent needs to know what's grayed
 * out on their own Home page, not just whoever manages the toggle). Only
 * `status` and `blocked` go to the browser — `bypassRank` itself stays
 * server-side; `blocked` is this specific caller's own bypass check
 * already resolved server-side (see accountCanBypass() in
 * _shared/featureStatus.js), so the client never needs to duplicate the
 * ROLE_RANK comparison itself.
 *
 * Used by: index.html (sidebar + TG Reply Threads/Promo Code Search
 * cards), app.js (form.html, so a direct/bookmarked URL to a blocked
 * topic still gets stopped), threads.html, promo.html.
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getAllFeatureStatuses, accountCanBypass } from "../_shared/featureStatus.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const statuses = await getAllFeatureStatuses(env);
  const items = {};
  for (const [id, s] of Object.entries(statuses)) {
    items[id] = {
      status: s.status,
      blocked: s.status !== "active" && !accountCanBypass(account, s.bypassRank),
    };
  }
  return json({ ok: true, items });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
