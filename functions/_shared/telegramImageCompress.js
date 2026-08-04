/**
 * telegramImageCompress.js  (SERVER-ONLY)
 *
 * Telegram's Bot API hard-caps a "photo" (sendPhoto / sendMediaGroup with
 * type:"photo") at 10 MB — see https://core.telegram.org/bots/api#sendphoto
 * ("The photo must be at most 10 MB in size"). Nothing in the Bot API lets
 * you raise that; the only way to keep something as an actual inline photo
 * (not a bare-📎 sendDocument) is to make the bytes smaller before upload.
 *
 * This re-encodes oversized images via Photon (a Rust image library
 * compiled to WASM — no Node/Sharp/Canvas APIs needed, so it runs fine in
 * the Workers/Pages Functions runtime), stepping quality/dimensions down
 * only as far as needed to clear the limit. Used ONLY for the bytes sent
 * to Telegram; the original attachment bytes uploaded to R2 (submit.js's
 * uploadAttachmentToR2 step, which runs before this) are never touched —
 * the archived screenshot in R2 / the Google Sheet link stays full quality.
 */

import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";

// Telegram's real ceiling is 10 MB; we target a bit under it so the
// multipart/form-data overhead and any rounding can't push us back over.
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const TARGET_BYTES = 9.3 * 1024 * 1024;

// Give up after this many shrink steps rather than looping forever on a
// pathological image — return whatever the last attempt produced (still
// smaller than the original, even if not perfectly under target).
const MAX_ATTEMPTS = 6;

/**
 * @param {Uint8Array} bytes original image bytes (already decoded from the
 *   incoming data URL)
 * @returns {Promise<{ bytes: Uint8Array, mimeType: string, changed: boolean }>}
 *   `changed` is false (bytes/mimeType returned as-is) when the input was
 *   already under the limit, or when Photon couldn't decode it (e.g. a
 *   format it doesn't support) — callers should fall through to their
 *   existing behavior in that case, not treat it as an error.
 */
export async function ensureUnderTelegramPhotoLimit(bytes, mimeType) {
  if (!bytes || bytes.byteLength <= TARGET_BYTES) {
    return { bytes, mimeType, changed: false };
  }

  let input;
  try {
    input = PhotonImage.new_from_byteslice(bytes);
  } catch {
    // Not something Photon can decode (or a corrupt file) — leave it
    // alone. The caller's existing sendPhoto→sendDocument fallback (single
    // attachments) or the outer catch (media groups) still handles this
    // safely, it just won't get the "stays a photo" treatment.
    return { bytes, mimeType, changed: false };
  }

  try {
    let width = input.get_width();
    let height = input.get_height();
    let quality = 85;
    let current = input; // current best PhotonImage to encode from
    let ownsCurrent = false; // whether `current` is a resized copy we must free ourselves

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = current.get_bytes_jpeg(quality);
      if (candidate.byteLength <= TARGET_BYTES) {
        input.free();
        if (ownsCurrent) current.free();
        return { bytes: candidate, mimeType: "image/jpeg", changed: true };
      }

      // Still too big: shrink dimensions (does the most work per step for
      // large photos) and ease off quality a little each pass.
      width = Math.max(320, Math.round(width * 0.75));
      height = Math.max(320, Math.round(height * 0.75));
      const resized = resize(input, width, height, SamplingFilter.Lanczos3);
      if (ownsCurrent) current.free();
      current = resized;
      ownsCurrent = true;
      if (quality > 45) quality -= 10;
    }

    // Last resort after MAX_ATTEMPTS — ship whatever we've got. Even if
    // it's still fractionally over TARGET_BYTES, it will be far smaller
    // than the original and likely under Telegram's real 10 MB ceiling.
    const finalBytes = current.get_bytes_jpeg(Math.max(quality, 40));
    input.free();
    if (ownsCurrent) current.free();
    return {
      bytes: finalBytes,
      mimeType: "image/jpeg",
      changed: true,
    };
  } catch {
    // Any Photon runtime error (OOM on a huge decode, etc.) — don't let a
    // compression bug take down the whole submission. Caller falls back
    // to its normal behavior with the original bytes.
    try { input.free(); } catch {}
    return { bytes, mimeType, changed: false };
  }
}

export { TELEGRAM_PHOTO_LIMIT_BYTES };
