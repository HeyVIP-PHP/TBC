/**
 * GET /api/screenshot/<key...>
 * Streams the object back out of R2. `params.path` is the array of path
 * segments Cloudflare Pages captures for a [[path]] catch-all route.
 */
export async function onRequestGet(context) {
  try {
    return await handleScreenshot(context);
  } catch (e) {
    return new Response(`Unexpected server error: ${String(e && e.message || e)}`, { status: 502 });
  }
}

async function handleScreenshot({ params, env }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) {
    return new Response("Server is missing the SCREENSHOTS_BUCKET R2 binding.", { status: 500 });
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.map(decodeURIComponent).join("/");

  const object = await bucket.get(key);
  if (!object) {
    return new Response("Not found (it may have expired — screenshots auto-delete after the configured retention period).", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
}
