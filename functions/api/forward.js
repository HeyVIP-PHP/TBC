/**
 * POST /api/forward
 *
 * "Generate to another Topic" — lets an agent create a brand-new ticket
 * in a DIFFERENT module (e.g. QA -> Account Issue), pre-filled from an
 * existing ticket, instead of the player having to re-explain the whole
 * issue and the agent re-typing everything from scratch. Behaves exactly
 * like a normal submission from that point on — new Telegram message,
 * new Sheet row (if that module logs to one), new trackable thread
 * record — the only difference is where the starting values came from.
 *
 * Body: { sourceThreadId, targetModule, fields, fieldMap, reporter, newAttachments }
 *   - sourceThreadId: the ticket being forwarded FROM.
 *   - targetModule: the module id being forwarded TO — must be different
 *     from sourceThread.module (forwarding a ticket to its own Topic
 *     doesn't mean anything).
 *   - fields / fieldMap: SAME shape submit.js's own request body uses —
 *     built client-side in threads.html from window.MODULES (schemas.js)
 *     for the TARGET module, pre-filled wherever a field key happens to
 *     exist on the source ticket too (Brand/UID/Number/Email etc.),
 *     left blank otherwise (most commonly Issue Type, which almost never
 *     has an equivalent on the source side). Brand is carried over
 *     read-only from the source ticket, not from this body, on purpose —
 *     see brandId below.
 *   - reporter: defaults to whoever clicked "Generate and send" (NOT
 *     necessarily the original submitter) — the person doing the
 *     forwarding is the one now vouching for these values.
 *   - newAttachments: OPTIONAL, same { name, type, dataUrl } shape
 *     submit.js's own `attachments` uses — for when the TARGET Topic's
 *     group needs a photo the SOURCE Topic's group never asked for (e.g.
 *     forwarding QA -> Account Issue might need a CNIC photo the QA
 *     ticket never collected). Sent ALONGSIDE the carried-over file_ids,
 *     not instead of them — see sendCombinedAttachments below for how a
 *     mix of "reuse this file_id" and "here are fresh bytes" ends up in
 *     one Telegram message together.
 *
 * Attachments are carried over by REUSING Telegram's own file_id(s) from
 * the source ticket — no re-download/re-upload through our server at
 * all, same idea as a native Telegram "Forward" (see
 * sendCombinedAttachments below).
 *
 * Traceability is bidirectional: the NEW ticket gets `forwardedFrom`
 * (set once, at creation — see createThread() in _shared/threads.js),
 * and the ORIGINAL ticket gets an entry appended to `forwardedTo` (see
 * addForwardedToLink()) — both rendered in threads.html as a small
 * clickable "↗️ Forwarded to/from ..." reference card.
 */
import { BRANDS, MODULE_META, MESSAGE_TEMPLATE, PROMOTION_MESSAGE_TEMPLATE, RECORD_TO_SHEET, SHEET_LAYOUT, PROMOTION_SHEET_CONFIG, SCREENSHOT_R2_ENABLED } from "../_shared/routing.js";
import { appendRowByColumns, writeRowForDate } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { getThread, createThread, addForwardedToLink } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeModule } from "../_shared/accounts.js";
import { buildTicketMessage, buildTitleAndSummary, resolveColumnValues, resolveSheetLayout, formatDateDDMMYYYY } from "../_shared/messageBuilders.js";
import { getRouteOverride } from "../_shared/routes.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
  const { sourceThreadId, targetModule: moduleId, fields, fieldMap, reporter, newAttachments } = body;
  if (!sourceThreadId || !moduleId || !Array.isArray(fields) || !fieldMap || typeof fieldMap !== "object" || !reporter) {
    return json({ ok: false, error: "Missing sourceThreadId, targetModule, fields, fieldMap, or reporter." }, 400);
  }

  const meta = MODULE_META[moduleId];
  if (!meta) return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  if (!canSeeModule(account, moduleId)) {
    return json({ ok: false, error: `You don't have access to submit ${meta.name} tickets.` }, 403);
  }

  const sourceThread = await getThread(env, sourceThreadId);
  if (!sourceThread) return json({ ok: false, error: "Source ticket not found." }, 404);
  if (sourceThread.module === moduleId) {
    return json({ ok: false, error: "This ticket is already in that Topic — nothing to forward." }, 400);
  }

  // Brand is carried over from the SOURCE ticket, not editable via the
  // request body — see the file header. Threads created before brandId
  // existed (pre "Sync to Sheet" feature) can't be forwarded; the ✏️
  // text editor still works on those, this feature just doesn't apply.
  const brandId = sourceThread.brandId;
  const brand = brandId && BRANDS[brandId];
  if (!brand) {
    return json({ ok: false, error: "This ticket doesn't support forwarding (it predates this feature, or its brand no longer exists)." }, 400);
  }
  if (!canSeeBrand(account, brand.name)) {
    return json({ ok: false, error: `You don't have access to submit tickets for ${brand.name}.` }, 403);
  }

  const routeOverride = await getRouteOverride(env, brandId, moduleId);
  const route = routeOverride || brand.telegram[moduleId] || brand.telegram.default;
  if (!route || !route.chatId) {
    return json({ ok: false, error: `No Telegram routing configured for ${meta.name} yet — ask a SuperAdmin to set it up under TG Group / Channel.` }, 400);
  }

  const fileIds = sourceThread.attachmentFileIds || [];

  // Upload to R2 first (same reasoning/order submit.js uses — so the
  // message text below can include a real, directly-openable link) if
  // this TARGET module wants one. This was missing entirely in the
  // first version of forwarding — the Sheet's "Screenshot Link" column
  // (which specifically expects an R2 url, not a Telegram file_id or
  // deep-link) came out empty for every forwarded ticket, even ones
  // with real attachments. Two sources of bytes to upload:
  //   1. Freshly-added attachments — already have raw bytes (dataUrl)
  //      right here in the request body, identical to a normal
  //      submission's attachments.
  //   2. Carried-over attachments — only have a Telegram file_id;
  //      have to download the actual bytes from Telegram FIRST (same
  //      two-step getFile + download dance functions/api/attachment/
  //      [fileId].js already does for viewing them) before they can be
  //      re-uploaded to R2.
  const r2Links = [];
  const r2Errors = [];
  if (env.SCREENSHOTS_BUCKET && SCREENSHOT_R2_ENABLED[moduleId]) {
    const origin = new URL(request.url).origin;
    for (const att of newAttachments || []) {
      try {
        const key = await uploadAttachmentToR2(env, { moduleId, brandId, attachment: att });
        r2Links.push(screenshotUrl(origin, key));
      } catch (e) {
        r2Errors.push(`${att.name || "new attachment"}: ${String((e && e.message) || e)}`);
      }
    }
    for (const fid of fileIds) {
      try {
        const { bytes, contentType, filePath } = await downloadTelegramFile(env.TELEGRAM_BOT_TOKEN, fid);
        const key = await uploadBytesToR2(env, { moduleId, brandId, name: filePath.split("/").pop(), type: contentType, bytes });
        r2Links.push(screenshotUrl(origin, key));
      } catch (e) {
        r2Errors.push(`carried-over attachment: ${String((e && e.message) || e)}`);
      }
    }
  }
  const screenshotLink = r2Links.join(", ");

  const text = buildTicketMessage({
    moduleId,
    brandId,
    meta,
    brand,
    fieldMap,
    fields,
    reporter,
    screenshotLink,
    messageTemplate: MESSAGE_TEMPLATE,
    promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
  });

  let tgResult;
  try {
    tgResult = await sendCombinedAttachments({ botToken: env.TELEGRAM_BOT_TOKEN, route, text, fileIds, newAttachments: newAttachments || [] });
  } catch (e) {
    return json({ ok: false, error: `Telegram send failed: ${String((e && e.message) || e)}` }, 502);
  }
  // Fallback link resolveColumnValues() reaches for when THIS module
  // doesn't have R2 enabled (screenshotLink would be "") — a Telegram
  // deep-link to the message itself, same as a normal submission's
  // attachmentLinks. Only meaningful once tgResult.messageId exists,
  // which is why this is computed here and not alongside r2Links above.
  const attachmentLinks = (fileIds.length || (newAttachments || []).length) ? [buildMessageLink(route, tgResult.messageId)] : [];

  // Sheet write — same pattern/order submit.js uses (write BEFORE
  // createThread so a real row's number can be captured into sheetRef
  // for the new ticket's own future "Sync to Sheet" edits). Non-fatal —
  // the Telegram message is already the source of truth if this fails.
  let sheetLogged = false;
  let sheetError = null;
  let sheetRef = null;
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  const sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && promoConfig)
    : !!(RECORD_TO_SHEET[moduleId] && brand.sheetId);
  if (sheetAttempted) {
    try {
      if (moduleId === "promotion_request") {
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const { row } = await appendRowByColumns(env, promoConfig.sheetId, promoConfig.tab, promoConfig.startColumn, values);
        if (row) sheetRef = { sheetId: promoConfig.sheetId, tab: promoConfig.tab, startColumn: promoConfig.startColumn, columns: promoConfig.columns, row };
      } else {
        const layoutEntry = SHEET_LAYOUT[moduleId];
        if (layoutEntry && layoutEntry.pairByDate) {
          const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
          const shiftValue = fieldMap[layoutEntry.selectorField];
          const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
          await writeRowForDate(env, brand.sheetId, layoutEntry.tab, {
            leftBlock: layoutEntry.leftBlock,
            rightBlock: layoutEntry.rightBlock,
            activeSide,
            dateValue,
            values,
          });
        } else {
          const layout = resolveSheetLayout(layoutEntry, fieldMap);
          if (layout) {
            const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
            const { row } = await appendRowByColumns(env, brand.sheetId, layout.tab, layout.startColumn, values);
            if (row) sheetRef = { sheetId: brand.sheetId, tab: layout.tab, startColumn: layout.startColumn, columns: layout.columns, row };
          }
        }
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String((e && e.message) || e);
    }
  }

  const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
  const forwardedFrom = {
    threadId: sourceThread.id,
    module: sourceThread.module,
    moduleName: sourceThread.moduleName,
    title: sourceThread.title,
  };

  let newThread;
  try {
    newThread = await createThread(env, {
      module: moduleId,
      moduleName: meta.name,
      icon: meta.emoji,
      accent: meta.accent,
      brand: brand.name,
      brandId,
      title,
      submitter: reporter,
      chatId: route.chatId,
      topicId: route.topicId,
      rootMessageId: tgResult.messageId,
      rootMessageIds: tgResult.messageIds,
      rootText: text,
      hasMedia: fileIds.length > 0 || (newAttachments || []).length > 0,
      attachmentFileIds: tgResult.attachmentFileIds.length ? tgResult.attachmentFileIds : fileIds,
      summary,
      fieldMap,
      screenshotLink,
      sheetRef,
      forwardedFrom,
    });
  } catch (e) {
    // The Telegram message + Sheet row (if any) already went through at
    // this point — only the trackable-thread bookkeeping failed. Say so
    // plainly rather than implying nothing happened.
    return json({ ok: false, error: `Sent to Telegram, but couldn't be saved as a trackable ticket: ${String((e && e.message) || e)}` }, 500);
  }

  try {
    await addForwardedToLink(env, sourceThreadId, {
      threadId: newThread.id,
      module: moduleId,
      moduleName: meta.name,
      title,
      at: new Date().toISOString(),
    });
  } catch {
    // Non-fatal — the forward itself already fully succeeded; this is
    // only the backlink shown on the ORIGINAL ticket.
  }

  return json({ ok: true, thread: newThread, sheetAttempted, sheetLogged, sheetError, r2Errors: r2Errors.length ? r2Errors : undefined });
}

// Reuses Telegram's own file_id(s) from the source ticket instead of
// re-downloading + re-uploading actual bytes — near-instant regardless
// of file size, and Telegram itself does the copying. Assumes every
// file_id is a photo (true for every module's "Supporting Screenshots"
// attachments today, since submit.js always prefers sendPhoto for
// images — see looksLikeImage() there) — sendOnePhotoOrDocument() below
// transparently falls back to sendDocument for any individual file_id
// Telegram rejects as a photo.
// Handles every combination: only carried-over file_ids, only fresh
// uploads, both mixed together, or neither (text-only). Telegram's
// sendMediaGroup natively accepts a MIX of "reuse this file_id" entries
// and "here's a fresh upload via attach://name" entries in the same
// call — that's what makes 2+ total attachments, of either kind, work
// as one native-looking message instead of two separate ones.
async function sendCombinedAttachments({ botToken, route, text, fileIds, newAttachments }) {
  const total = fileIds.length + newAttachments.length;

  if (total === 0) {
    const payload = { chat_id: route.chatId, text, parse_mode: "HTML" };
    if (route.topicId) payload.message_thread_id = Number(route.topicId);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "unknown Telegram error");
    return { messageId: data.result.message_id, messageIds: [data.result.message_id], attachmentFileIds: [] };
  }

  if (total === 1) {
    return fileIds.length
      ? await sendOnePhotoOrDocument({ botToken, route, text, fileId: fileIds[0] })
      : await sendOneFreshUpload({ botToken, route, text, attachment: newAttachments[0] });
  }

  // 2+ total — one sendMediaGroup call, FormData throughout (needed the
  // moment ANY fresh upload is involved; harmless/still valid even for
  // an all-file_id group).
  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));

  const media = [];
  fileIds.forEach((fid) => media.push({ type: "photo", media: fid }));
  newAttachments.forEach((att, i) => {
    const isImage = looksLikeImage(att.type, att.name);
    media.push({ type: isImage ? "photo" : "document", media: `attach://newfile${i}` });
  });
  media[0].caption = text;
  media[0].parse_mode = "HTML";
  form.append("media", JSON.stringify(media));

  newAttachments.forEach((att, i) => {
    const bytes = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const blob = new Blob([bytes], { type: att.type || "application/octet-stream" });
    form.append(`newfile${i}`, blob, att.name || `attachment${i}`);
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    // Most likely cause: one of the carried-over file_ids isn't
    // actually a photo (a media group requires every "photo"-typed
    // entry to genuinely resolve as one) — fall back to sending
    // everything as separate messages instead, each auto-detecting
    // photo vs document on its own.
    const sent = [];
    for (let i = 0; i < fileIds.length; i++) {
      sent.push(await sendOnePhotoOrDocument({ botToken, route, text: sent.length === 0 ? text : undefined, fileId: fileIds[i] }));
    }
    for (let i = 0; i < newAttachments.length; i++) {
      sent.push(await sendOneFreshUpload({ botToken, route, text: sent.length === 0 ? text : undefined, attachment: newAttachments[i] }));
    }
    return { messageId: sent[0].messageId, messageIds: sent.map((s) => s.messageId), attachmentFileIds: sent.flatMap((s) => s.attachmentFileIds) };
  }
  return {
    messageId: data.result[0].message_id,
    // EVERY message_id in the album — see the comment on this same
    // field in submit.js's sendTelegramWithAttachments() for why this
    // matters (recallRoot() needs to delete all of them, not just the
    // first/captioned one).
    messageIds: data.result.map((m) => m.message_id),
    attachmentFileIds: data.result.map((m) => (m.photo?.[m.photo.length - 1] || m.document)?.file_id).filter(Boolean),
  };
}

// Same extension-or-declared-type heuristic submit.js's own
// looksLikeImage() uses — kept as a separate local copy rather than a
// shared import since this file already keeps its Telegram-sending
// helpers self-contained (matches submit.js's own pattern of not
// sharing these across route files).
function looksLikeImage(type, name) {
  if ((type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name || "");
}

async function sendOneFreshUpload({ botToken, route, text, attachment }) {
  const { name, type, dataUrl } = attachment;
  const bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });
  const isImage = looksLikeImage(type, name);
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";

  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));
  form.append(field, blob, name || "attachment");
  if (text) {
    form.append("caption", text);
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  const fileId = isImage
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id
    : data.result.document?.file_id;
  return { messageId: data.result.message_id, messageIds: [data.result.message_id], attachmentFileIds: fileId ? [fileId] : [] };
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

// Downloads a Telegram-hosted file's actual bytes by file_id — same
// two-step getFile + download dance functions/api/attachment/[fileId].js
// already does to let an agent VIEW a carried-over attachment; this is
// the same thing, just so those bytes can be re-uploaded to R2 (see
// uploadBytesToR2 below) instead of streamed to a browser.
async function downloadTelegramFile(botToken, fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error(info.description || "Telegram couldn't resolve this file.");
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileRes.ok) throw new Error("Telegram couldn't deliver this file.");
  const buffer = await fileRes.arrayBuffer();
  const contentType = fileRes.headers.get("content-type") || "application/octet-stream";
  return { bytes: new Uint8Array(buffer), contentType, filePath };
}

// Same key format/bucket _shared/r2.js's uploadAttachmentToR2() uses —
// this is a separate function (not that one) only because it already
// has raw bytes in hand (freshly downloaded from Telegram, see
// downloadTelegramFile above) and skipping the dataUrl-string round trip
// avoids btoa()/atob() choking on very large files.
async function uploadBytesToR2(env, { moduleId, brandId, name, type, bytes }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) throw new Error("Missing SCREENSHOTS_BUCKET R2 binding");
  const safeName = (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${moduleId}/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type || "application/octet-stream" } });
  return key;
}

function buildMessageLink(route, messageId) {
  const internalId = String(route.chatId).replace(/^-100/, "");
  return route.topicId
    ? `https://t.me/c/${internalId}/${route.topicId}/${messageId}`
    : `https://t.me/c/${internalId}/${messageId}`;
}

async function sendOnePhotoOrDocument({ botToken, route, text, fileId }) {
  const basePayload = { chat_id: route.chatId };
  if (route.topicId) basePayload.message_thread_id = Number(route.topicId);
  if (text) {
    basePayload.caption = text;
    basePayload.parse_mode = "HTML";
  }

  let res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...basePayload, photo: fileId }),
  });
  let data = await res.json();
  if (!data.ok) {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...basePayload, document: fileId }),
    });
    data = await res.json();
    if (!data.ok) throw new Error(data.description || "unknown Telegram error");
    return { messageId: data.result.message_id, messageIds: [data.result.message_id], attachmentFileIds: [data.result.document?.file_id].filter(Boolean) };
  }
  return { messageId: data.result.message_id, messageIds: [data.result.message_id], attachmentFileIds: [data.result.photo?.[data.result.photo.length - 1]?.file_id].filter(Boolean) };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
