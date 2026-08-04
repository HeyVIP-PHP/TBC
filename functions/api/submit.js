import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED, PROMOTION_SHEET_CONFIG, PROMOTION_MESSAGE_TEMPLATE, DEPOSIT_CHANNEL_PSEUDO_MODULES, depositChannelModuleId } from "../_shared/routing.js";
import { appendRowToSheet, appendRowByColumns, appendRowByColumnsWithAutoCreate, writeRowForDate } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { createThread } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeModule } from "../_shared/accounts.js";
import { getRouteOverride } from "../_shared/routes.js";
import { resolveSheetTarget } from "../_shared/sheetRoutes.js";
import { getFeatureStatus, accountCanBypass } from "../_shared/featureStatus.js";
import {
  resolveColumnValues, resolveSheetLayout, formatDateDDMMYYYY, buildTicketMessage, buildTitleAndSummary,
} from "../_shared/messageBuilders.js";
import { ensureUnderTelegramPhotoLimit } from "../_shared/telegramImageCompress.js";

// Deposit Request's per-channel pseudo-modules (deposit_copopay etc.,
// see routing.js) exist only as Telegram routing targets — they must
// never be accepted as a real `moduleId` in a submission, only ever
// looked up internally once a real "deposit_request" submission's
// `channel` field tells us which one to route through.
const VALID_MODULES = Object.keys(MODULE_META).filter((id) => !DEPOSIT_CHANNEL_PSEUDO_MODULES.includes(id));

// Top-level safety net. Everything below already handles its OWN expected
// failure modes (bad JSON, missing config, Telegram/Sheets errors) with a
// clean { ok:false, error } response — this catch is for anything
// UNEXPECTED (a bug, a malformed routing.js entry, whatever) so a ticket
// submission never comes back as a raw platform error page. The agent
// always gets JSON back, even when something we didn't anticipate breaks.
export async function onRequestPost(context) {
  try {
    return await handleSubmit(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSubmit({ request, env }) {
  // The whole hub now requires login (business owner's call — previously
  // only TG Reply Threads did). This is the server-side half of that: the
  // frontend redirect to /login.html is the UX, this is what actually
  // stops an unauthenticated request hitting the API directly.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { module: moduleId, brand: brandId, reporter, fields, attachments, idempotencyKey } = body || {};

  if (!VALID_MODULES.includes(moduleId)) {
    return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }
  // Real enforcement, not just hiding it from the sidebar — an agent
  // scoped away from a topic (account.allowedModules, set in the Agent
  // Personal Profile modal) can't submit to it even by calling this
  // endpoint directly, bypassing the Home page and app.js's own checks
  // entirely. Checked before the brand lookup below on purpose — no
  // reason to even validate brandId for a module this account can't use.
  if (!canSeeModule(account, moduleId)) {
    return json({ ok: false, error: `Your account doesn't have access to the ${MODULE_META[moduleId]?.name || moduleId} topic.` }, 403);
  }
  // Settings (Maintenance / Coming soon) — a SEPARATE axis from
  // allowedModules above: this can block an agent who otherwise DOES
  // have access, while a toggle is on. Real enforcement, not just the
  // sidebar graying it out and app.js blocking the form page — an agent
  // who already had form.html open before the toggle flipped, or who
  // hits this endpoint directly, still gets stopped here.
  const featureStatus = await getFeatureStatus(env, moduleId);
  if (featureStatus.status !== "active" && !accountCanBypass(account, featureStatus.bypassRoles)) {
    const label = featureStatus.status === "coming_soon" ? "not available yet" : "under maintenance";
    return json({ ok: false, error: `${MODULE_META[moduleId]?.name || moduleId} is currently ${label}. Please try again later.` }, 403);
  }
  const brand = BRANDS[brandId];
  if (!brand) {
    return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  }
  // Real enforcement, not just hiding it from the dropdown — an agent
  // scoped to specific brands (account.allowedBrands) can't submit for
  // any other brand even by calling this endpoint directly. The form's
  // Brand/Platform dropdown (app.js) already only shows brands they're
  // allowed to see; this is the server-side half that actually matters.
  if (!canSeeBrand(account, brand.name)) {
    return json({ ok: false, error: `You don't have access to submit tickets for ${brand.name}.` }, 403);
  }
  if (!reporter || !Array.isArray(fields)) {
    return json({ ok: false, error: "Missing reporter or fields." }, 400);
  }

  // Dedupe: the same submit CLICK occasionally reaches the server twice
  // (flaky mobile network retry, double-tap, an edge node retrying a
  // request it thinks failed) — without this, that means two identical
  // Telegram messages, two duplicate ticket records, and a Sheet write
  // race that can under- or over-count rows. idempotencyKey is a fresh
  // random ID app.js generates per submit click (not tied to form
  // content), so resubmitting after a genuine failure still works fine —
  // only an actual duplicate delivery of the same click gets short-circuited.
  if (idempotencyKey && env.THREADS_KV) {
    const dedupeKey = `submit_dedupe:${idempotencyKey}`;
    const already = await env.THREADS_KV.get(dedupeKey);
    if (already) {
      // Already processed (or still being processed) — hand back the
      // exact same result instead of doing everything a second time.
      return new Response(already, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Placeholder first — so a near-simultaneous duplicate request (the
    // two-requests-racing case, not just "the first one finished and a
    // retry came later") also gets caught immediately, before this
    // request has even finished processing. 60s (not the originally
    // planned 30s) because Cloudflare KV flat-out rejects any
    // expirationTtl under 60 — this isn't a tunable choice, it's the
    // platform's actual minimum.
    await env.THREADS_KV.put(dedupeKey, JSON.stringify({ ok: true, duplicate: true, note: "Original submission was still processing — this is not a second ticket." }), { expirationTtl: 60 });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);
  }

  const meta = MODULE_META[moduleId];
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  // Deposit Request routes by CHANNEL, not by module — each channel can
  // point at a completely different Telegram group (not just a different
  // topic in the same group), via the deposit_<channel> pseudo-module ids
  // in routing.js. Every other module routes by moduleId itself, same as
  // always.
  let routeModuleId = moduleId;
  if (moduleId === "deposit_request") {
    routeModuleId = depositChannelModuleId(fieldMap.channel);
    if (!routeModuleId) {
      return json({ ok: false, error: `Unknown deposit channel "${fieldMap.channel || ""}".` }, 400);
    }
  }
  // Live-editable routing (TG Group / Channel admin page) takes priority
  // over the hardcoded default — see _shared/routes.js. An empty/unset KV
  // means every brand+module just falls back to brand.telegram as before,
  // so this can't break anything that already works.
  const routeOverride = await getRouteOverride(env, brandId, routeModuleId);
  const route = routeOverride || brand.telegram[routeModuleId] || brand.telegram.default;
  if (!route || !route.chatId) {
    return json({ ok: false, error: moduleId === "deposit_request"
      ? `No Telegram group configured yet for the "${fieldMap.channel}" deposit channel on ${brand.name}. Ask a SuperAdmin to set it under Account Management → TG Group / Channel.`
      : `No Telegram group configured yet for ${meta?.name || moduleId} on ${brand.name}.` }, 400);
  }

  // 1. Upload attachments to R2 first (if configured) so the message text
  //    can include a real, directly-openable screenshot link.
  const r2Links = [];
  const r2Errors = [];
  if (env.SCREENSHOTS_BUCKET && SCREENSHOT_R2_ENABLED[moduleId] && Array.isArray(attachments) && attachments.length) {
    const origin = new URL(request.url).origin;
    for (const att of attachments) {
      try {
        const key = await uploadAttachmentToR2(env, { moduleId, brandId, attachment: att });
        r2Links.push(screenshotUrl(origin, key));
      } catch (e) {
        r2Errors.push(`${att.name}: ${e.message || e}`);
      }
    }
  }
  const screenshotLink = r2Links.join(", ");

  const text = buildTicketMessage({
    moduleId, brandId, meta, brand, fieldMap, fields, reporter, screenshotLink,
    messageTemplate: MESSAGE_TEMPLATE, promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
  });

  // 2. Send to Telegram — photo(s)/document(s) with the info as the caption,
  //    so it shows as one message instead of text + separate photo.
  let tgResult;
  const attachmentErrors = [];
  try {
    tgResult = await sendTelegramWithAttachments({ botToken, route, text, attachments: attachments || [] });
  } catch (e) {
    // Fall back to a plain text message so the ticket isn't lost even if
    // the attachment send fails (e.g. caption too long, bad file, etc).
    attachmentErrors.push(String(e.message || e));
    const fallback = await sendTelegramMessage({ botToken, route, text });
    if (!fallback.ok) {
      return json({ ok: false, error: `Telegram send failed: ${fallback.error}` }, 502);
    }
    tgResult = { messageId: fallback.messageId, messageIds: [fallback.messageId], attachmentLinks: [], attachmentFileIds: [], attachmentNames: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2. Optionally log to the brand's Google Sheet (fire-and-await, but don't
  //    fail the whole request if the sheet write fails — Telegram already has it).
  // Runs BEFORE the thread record below on purpose: if this writes a real
  // row, we want its {sheetId, tab, startColumn, columns, row} saved on
  // the thread as `sheetRef`, so a later edit (functions/api/threads/[id].js
  // editDetails) knows exactly which Sheet cell range to overwrite instead
  // of appending a duplicate row.
  let sheetLogged = false;
  let sheetError = null;
  let sheetRef = null;
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  // Issue Submission Gsheet target — Integrations admin page override
  // (functions/api/admin/sheet-routes.js) takes priority over the
  // hardcoded default (brand.sheetId / promoConfig.sheetId); falls back
  // cleanly to the code default when nothing's been saved through that
  // page yet, same layering as TG routing's getRouteOverride(). Only the
  // DESTINATION (sheetId + tab) is overridable — column layout
  // (startColumn/columns/headers) always comes from the code, never KV,
  // see the header of _shared/sheetRoutes.js for why.
  const defaultSheetId = moduleId === "promotion_request" ? (promoConfig?.sheetId || "") : brand.sheetId;
  const defaultTab = moduleId === "promotion_request" ? (promoConfig?.tab || "") : (SHEET_LAYOUT[moduleId]?.tab || "");
  const sheetTarget = await resolveSheetTarget(env, brandId, moduleId, defaultSheetId, defaultTab);
  const sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && promoConfig && sheetTarget.sheetId)
    : !!(RECORD_TO_SHEET[moduleId] && sheetTarget.sheetId);
  if (sheetAttempted) {
    try {
      if (moduleId === "promotion_request") {
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const { row } = await appendRowByColumns(env, sheetTarget.sheetId, sheetTarget.tab, promoConfig.startColumn, values);
        if (row) sheetRef = { sheetId: sheetTarget.sheetId, tab: sheetTarget.tab, startColumn: promoConfig.startColumn, columns: promoConfig.columns, row };
      } else {
        const layoutEntry = SHEET_LAYOUT[moduleId];
        if (layoutEntry && layoutEntry.pairByDate) {
          const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
          const shiftValue = fieldMap[layoutEntry.selectorField];
          const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
          await writeRowForDate(env, sheetTarget.sheetId, sheetTarget.tab, {
            leftBlock: layoutEntry.leftBlock,
            rightBlock: layoutEntry.rightBlock,
            activeSide,
            dateValue,
            values,
          });
          // No row-tracking here — writeRowForDate() may reuse an existing
          // row shared with the other shift, and doesn't report a row
          // number back. Daily Report tickets just don't support the
          // Sheet-sync half of editDetails() — Telegram-only edits still
          // work fine for them.
        } else {
          const layout = resolveSheetLayout(layoutEntry, fieldMap);
          if (layout) {
            const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
            const { row } = layout.autoCreate
              ? await appendRowByColumnsWithAutoCreate(env, sheetTarget.sheetId, sheetTarget.tab, layout.startColumn, layout.headers, values)
              : await appendRowByColumns(env, sheetTarget.sheetId, sheetTarget.tab, layout.startColumn, values);
            if (row) sheetRef = { sheetId: sheetTarget.sheetId, tab: sheetTarget.tab, startColumn: layout.startColumn, columns: layout.columns, row };
          } else {
            const row = {
              timestamp,
              brand: brand.name,
              reporter,
              ...Object.fromEntries(fields.map((f) => [f.key, f.value])),
              attachments: (attachments || []).map((a) => a.name).join(", "),
            };
            await appendRowToSheet(env, sheetTarget.sheetId, moduleId, row);
          }
        }
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  // 2b. Create a TG Reply Threads record so agent replies to this exact
  //     Telegram message can be tracked in the dashboard. Optional feature —
  //     skipped silently until THREADS_KV is bound (see wrangler.toml).
  let threadId = null;
  if (env.THREADS_KV) {
    try {
      const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
      const thread = await createThread(env, {
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
        hasMedia: Array.isArray(attachments) && attachments.length > 0,
        attachmentFileIds: tgResult.attachmentFileIds || [],
        attachmentNames: tgResult.attachmentNames || [],
        summary,
        fieldMap,
        screenshotLink,
        attachmentLinks,
        sheetRef,
      });
      threadId = thread.id;
    } catch {
      // Non-fatal — the Telegram message and sheet row are already the
      // source of truth; the reply-tracking record is a nice-to-have.
    }
  }

  const finalResponse = {
    ok: true,
    telegramMessageId: tgResult.messageId,
    threadId,
    sheetAttempted,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  };
  if (idempotencyKey && env.THREADS_KV) {
    // Overwrite the 30s placeholder with the real result, now kept
    // around for 10 minutes — long enough to cover any realistic delayed
    // retry, short enough not to matter for KV's daily write quota.
    await env.THREADS_KV.put(`submit_dedupe:${idempotencyKey}`, JSON.stringify(finalResponse), { expirationTtl: 600 });
  }
  return json(finalResponse);
}


async function sendTelegramMessage({ botToken, route, text }) {
  const payload = {
    chat_id: route.chatId,
    text,
    parse_mode: "HTML",
  };
  if (route.topicId) payload.message_thread_id = route.topicId;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.description || "unknown Telegram error" };
  }
  return { ok: true, messageId: data.result.message_id };
}

// Browsers usually set File.type correctly, but not always — a file
// re-uploaded after being downloaded from somewhere else (e.g. saved out
// of Telegram itself, which often renames photos to a plain numeric
// filename like "6111620814923827982_1.jpg") can come through with an
// empty or generic type. Falling back to the file extension catches
// those cases, so an actual photo still gets sent via sendPhoto (shows
// as an inline thumbnail in Telegram) instead of silently degrading to
// sendDocument (shows as a bare 📎 filename with no preview).
function looksLikeImage(type, name) {
  if ((type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name || "");
}

async function sendTelegramWithAttachments({ botToken, route, text, attachments }) {
  if (!attachments.length) {
    const r = await sendTelegramMessage({ botToken, route, text });
    if (!r.ok) throw new Error(r.error);
    return { messageId: r.messageId, messageIds: [r.messageId], attachmentLinks: [], attachmentFileIds: [], attachmentNames: [] };
  }

  if (attachments.length === 1) {
    const { messageId, fileId, name } = await sendSingleWithCaption({ botToken, route, text, attachment: attachments[0] });
    return {
      messageId,
      messageIds: [messageId],
      attachmentLinks: [buildMessageLink(route, messageId)],
      attachmentFileIds: fileId ? [fileId] : [],
      attachmentNames: fileId ? [name] : [],
    };
  }

  const allImages = attachments.every((a) => looksLikeImage(a.type, a.name));
  if (allImages) {
    const sent = await sendMediaGroup({ botToken, route, text, attachments });
    const withFileId = sent.filter((s) => s.fileId);
    return {
      messageId: sent[0].messageId,
      // EVERY message_id in the album, not just the first/captioned one —
      // recallRoot() (threads/[id].js) needs to delete all of them; see
      // that file's comment for the bug this fixes.
      messageIds: sent.map((s) => s.messageId),
      attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
      attachmentFileIds: withFileId.map((s) => s.fileId),
      attachmentNames: withFileId.map((s) => s.name),
    };
  }

  // Mixed image/document types can't share one album — send each as its own
  // message, with the caption only on the first so it still reads as "the
  // ticket", not repeated noise on every attachment.
  const sent = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = await sendSingleWithCaption({ botToken, route, text: i === 0 ? text : undefined, attachment: attachments[i] });
    sent.push(result);
  }
  const withFileId = sent.filter((s) => s.fileId);
  return {
    messageId: sent[0].messageId,
    messageIds: sent.map((s) => s.messageId),
    attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
    attachmentFileIds: withFileId.map((s) => s.fileId),
    attachmentNames: withFileId.map((s) => s.name),
  };
}

async function sendSingleWithCaption({ botToken, route, text, attachment }) {
  const { name, type, dataUrl } = attachment;
  let bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  let sendType = type || "application/octet-stream";

  const isImage = looksLikeImage(type, name);
  // Shrink upfront if it's an image over Telegram's 10MB photo cap, so it
  // still goes out as an inline photo instead of falling through to the
  // sendPhoto-failed→sendDocument fallback below (which turns it into a
  // bare 📎 file with no preview).
  if (isImage) {
    const compressed = await ensureUnderTelegramPhotoLimit(bytes, sendType);
    bytes = compressed.bytes;
    sendType = compressed.mimeType;
  }
  const blob = new Blob([bytes], { type: sendType });

  const method = isImage ? "sendPhoto" : "sendDocument";

  const buildForm = (fieldName) => {
    const form = new FormData();
    form.append("chat_id", route.chatId);
    if (route.topicId) form.append("message_thread_id", String(route.topicId));
    form.append(fieldName, blob, name || "attachment");
    if (text) {
      form.append("caption", text);
      form.append("parse_mode", "HTML");
    }
    return form;
  };

  let res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: buildForm(isImage ? "photo" : "document") });
  let data = await res.json();
  let sentAsDocument = false;
  // Telegram can reject a genuine image as a "photo" for reasons that
  // have nothing to do with it being a valid file — most commonly
  // PHOTO_INVALID_DIMENSIONS for an extreme aspect-ratio screenshot.
  // Without this, the whole ticket used to fall all the way back to the
  // attachment-less plain-text branch in handleSubmit()'s catch, losing
  // the screenshot entirely. Same fallback forward.js's
  // sendOnePhotoOrDocument() already uses for carried-over file_ids.
  if (!data.ok && method === "sendPhoto") {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: buildForm("document") });
    data = await res.json();
    sentAsDocument = true;
  }
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  const fileId = sentAsDocument
    ? data.result.document?.file_id || null
    : isImage
      ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
      : data.result.document?.file_id || null;
  return { messageId: data.result.message_id, fileId, name: name || null };
}

async function sendMediaGroup({ botToken, route, text, attachments }) {
  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));

  const media = attachments.map((att, i) => {
    const entry = { type: "photo", media: `attach://file${i}` };
    if (i === 0) {
      entry.caption = text;
      entry.parse_mode = "HTML";
    }
    return entry;
  });
  form.append("media", JSON.stringify(media));

  // Telegram rejects the ENTIRE album (sendMediaGroup is all-or-nothing) if
  // even ONE photo exceeds its 10MB "photo" cap — that used to mean a
  // single oversized screenshot in a 3-photo album silently dropped every
  // photo and fell all the way back to a photo-less text message (see
  // handleSubmit's catch). Shrink any offender down first so the whole
  // album still goes out as real inline photos, not documents.
  for (const att of attachments) {
    const bytes = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const { bytes: sendBytes, mimeType } = await ensureUnderTelegramPhotoLimit(bytes, att.type || "image/jpeg");
    att._sendBytes = sendBytes;
    att._sendMimeType = mimeType;
  }

  attachments.forEach((att, i) => {
    const blob = new Blob([att._sendBytes], { type: att._sendMimeType });
    form.append(`file${i}`, blob, att.name || `photo${i}`);
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  return data.result.map((m, i) => ({
    messageId: m.message_id,
    fileId: m.photo?.[m.photo.length - 1]?.file_id || null,
    name: attachments[i]?.name || null,
  }));
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function buildMessageLink(route, messageId) {
  const internalId = String(route.chatId).replace(/^-100/, "");
  return route.topicId
    ? `https://t.me/c/${internalId}/${route.topicId}/${messageId}`
    : `https://t.me/c/${internalId}/${messageId}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
