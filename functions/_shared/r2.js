/**
 * r2.js  (SERVER-ONLY)
 *
 * Uploads screenshot/document attachments to the R2 bucket bound as
 * `env.SCREENSHOTS_BUCKET` (set this binding name in Cloudflare Pages →
 * Settings → Functions → R2 bucket bindings, for both Production and
 * Preview). Files are served back out through our own
 * /api/screenshot/<key> route (see functions/api/screenshot/[[path]].js)
 * rather than R2's public r2.dev domain, so we control caching and don't
 * expose a raw Cloudflare storage URL.
 *
 * The bucket's own Object Lifecycle Rule (set in the R2 dashboard) handles
 * automatic deletion after N days — nothing to do here for that.
 */

export async function uploadAttachmentToR2(env, { moduleId, brandId, attachment }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) throw new Error("Missing SCREENSHOTS_BUCKET R2 binding");

  const { name, type, dataUrl } = attachment;
  const bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  const safeName = (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${moduleId}/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  await bucket.put(key, bytes, { httpMetadata: { contentType: type || "application/octet-stream" } });
  return key;
}

export function screenshotUrl(origin, key) {
  return `${origin}/api/screenshot/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
