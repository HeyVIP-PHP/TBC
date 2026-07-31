/**
 * GET /api/attachment/<fileId>  -> the actual image/file bytes, proxied
 * live from Telegram — nothing is stored on our side.
 *
 * WHY THIS EXISTS: an agent's reply attachment (sent via
 * functions/api/threads/[id].js's "reply" action) is only ever uploaded
 * to Telegram — no copy of it lives anywhere in R2 or KV, by deliberate
 * choice (business owner wanted the "click to view" feature WITHOUT
 * using any of our own storage). What DOES get saved is Telegram's own
 * `file_id` for that upload (see attachmentFileId on the message
 * record). This route is what turns that file_id back into real,
 * viewable bytes, on demand, only at the moment someone actually clicks
 * to look — nothing is fetched or cached ahead of time.
 *
 * How it works: Telegram's Bot API splits "get a file" into two calls —
 * `getFile` (resolves a file_id to a temporary `file_path`) then a
 * separate download endpoint using that path. Both calls need
 * TELEGRAM_BOT_TOKEN, which must NEVER reach the browser (the download
 * URL's path literally embeds the token: .../bot<TOKEN>/<file_path>) —
 * so this proxies the actual response body straight through instead of
 * ever redirecting the browser to a Telegram URL. Same reasoning as why
 * R2 attachments are served through /api/screenshot/<key> rather than a
 * raw bucket URL — the browser only ever talks to our own domain.
 *
 * Login-gated like every other thread-related endpoint — this doesn't
 * separately check which brand the file "belongs to" (a file_id alone
 * doesn't carry that info without a KV lookup this route deliberately
 * skips for simplicity), so treat this as "any logged-in agent can view
 * any attachment if they somehow get its file_id" — acceptable since
 * file_ids aren't guessable/enumerable (they're long opaque Telegram-
 * issued strings) and are only ever handed out via the thread data an
 * agent could already see.
 *
 * Trade-off worth knowing: Telegram file_ids are generally retrievable
 * for as long as the file exists on Telegram's own servers (no fixed
 * expiry like the temporary download URL has), but that's Telegram's
 * behavior, not a guarantee this code makes — if Telegram ever can't
 * resolve an old file_id, this route surfaces that as a clean error
 * rather than a broken image, see the response below.
 */
import { verifyRequest } from "../../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return new Response(`Unexpected server error: ${String((e && e.message) || e)}`, { status: 500 });
  }
}

async function handleGet({ request, env, params }) {
  const account = await verifyRequest(request, env);
  if (!account) return new Response("Login required.", { status: 401 });

  const fileId = params.fileId;
  if (!fileId) return new Response("Missing file id.", { status: 400 });
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("Server is missing TELEGRAM_BOT_TOKEN.", { status: 500 });

  const infoRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const info = await infoRes.json();
  if (!info.ok) {
    // Most common real-world cause: the file's genuinely no longer
    // resolvable on Telegram's side (very old, or the source message
    // was deleted) — surfaced as 404 rather than a generic 502, since
    // that's the accurate meaning for the person clicking the link.
    return new Response(info.description || "Telegram couldn't resolve this file.", { status: 404 });
  }

  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok || !fileRes.body) {
    return new Response("Telegram couldn't deliver this file.", { status: 502 });
  }

  // Priority order, most-to-least trustworthy:
  //   1. Guessing from the ORIGINAL filename the agent uploaded (we
  //      already know this on our own side — e.g. "photo.jpg" — it's
  //      the one piece of information Telegram never had a chance to
  //      lose or mangle, see the comment above).
  //   2. Telegram's own Content-Type header for the download — but
  //      SKIPPED if it's just the generic "application/octet-stream",
  //      since that's Telegram effectively saying "I don't know either"
  //      and blindly trusting it would short-circuit past the better
  //      guesses below.
  //   3. Guessing from Telegram's own internal file_path.
  //   4. Magic-bytes sniffing (read the file's actual header bytes) —
  //      only reached when 1–3 all came up empty, i.e. filename AND
  //      both Telegram-provided type hints are gone. This is the case
  //      for old records that never had a filename saved and whose
  //      file_path/Content-Type were already generic at upload time —
  //      filename/metadata are dead ends there, so the file's own bytes
  //      are the only signal left, and they're never lost as long as
  //      the file content itself isn't corrupted.
  //   5. Whatever Telegram's header said, even if generic.
  //   6. Hardcoded fallback, if genuinely nothing else worked out.
  const originalName = new URL(request.url).searchParams.get("name") || "";
  const tgContentType = fileRes.headers.get("Content-Type") || "";
  const preliminaryType =
    guessContentType(originalName) ||
    (tgContentType && tgContentType !== "application/octet-stream" ? tgContentType : null) ||
    guessContentType(filePath);

  const cacheHeaders = {
    // Private + short-lived — this is a live proxy, not a stable asset
    // URL; no reason for a shared/public cache to hold onto it, but a
    // brief cache is harmless if someone reopens the same image within
    // a few minutes (e.g. re-opening the lightbox).
    "Cache-Control": "private, max-age=300",
  };

  // Layers 1–3 already produced a trustworthy type — stream the body
  // straight through untouched. No need to buffer the whole file just
  // to peek at its header when we already know what it is.
  if (preliminaryType) {
    return new Response(fileRes.body, {
      status: 200,
      headers: { "Content-Type": preliminaryType, ...cacheHeaders },
    });
  }

  // Last resort: filename and every Telegram-provided type hint are
  // gone. Buffer the file (unavoidable here, since we need to read its
  // header bytes before deciding what to send) and sniff its magic
  // bytes. This has a real I/O/memory cost, which is exactly why it's
  // gated behind "everything else already failed" rather than run on
  // every request.
  let bodyBuffer = null;
  try {
    bodyBuffer = await fileRes.arrayBuffer();
  } catch (e) {
    bodyBuffer = null; // fall through to the generic-type response below
  }

  let finalType = tgContentType || "application/octet-stream";
  if (bodyBuffer) {
    const sniffed = await sniffTypeFromBytes(new Uint8Array(bodyBuffer)).catch(() => null);
    if (sniffed) finalType = sniffed;
  }

  return new Response(bodyBuffer, {
    status: 200,
    headers: { "Content-Type": finalType, ...cacheHeaders },
  });
}

// Reads the first few bytes of a file and compares them against known
// magic-byte signatures. Works even when the filename and every
// server-provided Content-Type hint are missing or generic, since this
// signature lives in the file's own content and survives regardless of
// what happened to its metadata — as long as the file isn't corrupted.
// Returns a MIME type string, or null if nothing matched.
async function sniffTypeFromBytes(bytes) {
  const head = bytes.slice(0, 12);
  const hex = Array.from(head)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hex.startsWith("25504446")) return "application/pdf"; // %PDF
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) return "image/gif"; // GIF87a / GIF89a
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "image/webp"; // RIFF....WEBP
  if (hex.startsWith("504b0304")) return "application/zip"; // also covers docx/xlsx/pptx
  if (hex.startsWith("4d5a")) return "application/x-msdownload"; // MZ (exe/dll)
  if (hex.slice(8, 16) === "66747970") return "video/mp4"; // ....ftyp
  if (hex.startsWith("1f8b")) return "application/gzip";
  // Extend as needed for this project's other expected formats.

  return null;
}

function guessContentType(pathOrName) {
  const ext = (pathOrName || "").split(".").pop().toLowerCase();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp",
    pdf: "application/pdf",
  };
  return map[ext] || null;
}
