/**
 * routes.js  (SERVER-ONLY)
 *
 * KV-backed overrides for Telegram routing (chatId / topicId), layered on
 * top of the hardcoded defaults in _shared/routing.js's `BRANDS` object.
 * This is what lets a SuperAdmin change routing live from the browser
 * (the "TG Group / Channel" admin page) instead of needing a code edit +
 * redeploy for every chatId/topicId change.
 *
 * Stored in the same THREADS_KV namespace as accounts/offices, under its
 * own key prefix so nothing collides:
 *   route:<brandId>:<moduleId>  ->  { chatId, topicId }
 *
 * submit.js checks getRouteOverride() first; if nothing is stored for a
 * given brand+module, it falls back to the hardcoded BRANDS default — so
 * turning this on with an empty KV changes nothing that already works,
 * and only the brand/module combos someone has actually edited through
 * the admin UI diverge from the code defaults.
 */

function routeKey(brandId, moduleId) {
  return `route:${brandId}:${moduleId}`;
}

function parseRoute(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.chatId) return null; // guard against a malformed/emptied entry
    return { chatId: String(parsed.chatId), topicId: parsed.topicId === undefined ? null : parsed.topicId };
  } catch {
    return null;
  }
}

// Used at submission time (functions/api/submit.js) — a single KV read,
// null if nothing overridden for this brand+module (caller falls back to
// the hardcoded BRANDS default).
export async function getRouteOverride(env, brandId, moduleId) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(routeKey(brandId, moduleId));
  return parseRoute(raw);
}

// Fetches every brand x module override in one batch — used by the admin
// GET endpoint to render the full grid. Cheap even without an index:
// today that's 5 brands x 6 modules = 30 reads, well within free-tier
// limits for a page that's only opened occasionally by a SuperAdmin.
export async function getAllRouteOverrides(env, brandIds, moduleIds) {
  if (!env.THREADS_KV) return {};
  const pairs = [];
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) pairs.push([brandId, moduleId]);
  }
  const raws = await Promise.all(pairs.map(([b, m]) => env.THREADS_KV.get(routeKey(b, m))));
  const result = {};
  pairs.forEach(([brandId, moduleId], i) => {
    const parsed = parseRoute(raws[i]);
    if (parsed) result[`${brandId}|${moduleId}`] = parsed;
  });
  return result;
}

export async function saveRouteOverride(env, brandId, moduleId, { chatId, topicId }) {
  const trimmedChatId = String(chatId || "").trim();
  if (!trimmedChatId) throw new Error("Chat ID is required.");
  const trimmedTopic = topicId === "" || topicId === null || topicId === undefined ? null : Number(topicId);
  const value = { chatId: trimmedChatId, topicId: Number.isFinite(trimmedTopic) ? trimmedTopic : null };
  await env.THREADS_KV.put(routeKey(brandId, moduleId), JSON.stringify(value));
  return value;
}

export async function deleteRouteOverride(env, brandId, moduleId) {
  await env.THREADS_KV.delete(routeKey(brandId, moduleId));
}
