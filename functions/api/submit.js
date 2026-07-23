import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED, RISK_ISSUE_AUTO_REMARKS, RISK_ISSUE_FIELD_EMOJI, ACCOUNT_ISSUE_FIELD_STYLE, PROMOTION_SHEET_CONFIG, PROMOTION_MESSAGE_TEMPLATE } from "../_shared/routing.js";
import { appendRowToSheet, appendRowByColumns, writeRowForDate } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { createThread } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand } from "../_shared/accounts.js";
import { getRouteOverride } from "../_shared/routes.js";

const VALID_MODULES = Object.keys(MODULE_META);

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

  const { module: moduleId, brand: brandId, reporter, fields, attachments } = body || {};

  if (!VALID_MODULES.includes(moduleId)) {
    return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
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

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);
  }

  const meta = MODULE_META[moduleId];
  // Live-editable routing (TG Group / Channel admin page) takes priority
  // over the hardcoded default — see _shared/routes.js. An empty/unset KV
  // means every brand+module just falls back to brand.telegram as before,
  // so this can't break anything that already works.
  const routeOverride = await getRouteOverride(env, brandId, moduleId);
  const route = routeOverride || brand.telegram[moduleId] || brand.telegram.default;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));

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

  const template = resolveTemplate(MESSAGE_TEMPLATE[moduleId], fieldMap);
  let text;
  if (template) {
    text = buildMessageFromTemplate({ template, meta, brandName: brand.name, fieldMap, reporter, screenshotLink });
  } else if (moduleId === "risk_issue") {
    text = buildRiskIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  } else if (moduleId === "account_issue") {
    text = buildAccountIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  } else if (moduleId === "promotion_request" && PROMOTION_MESSAGE_TEMPLATE[`${brandId}|${fieldMap.promotion}`]) {
    text = buildPromotionRequestMessage(PROMOTION_MESSAGE_TEMPLATE[`${brandId}|${fieldMap.promotion}`], { brandName: brand.name, fieldMap, reporter });
  } else {
    text = buildMessage({ meta, brandName: brand.name, reporter, fields, moduleId, fieldMap });
  }

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
    tgResult = { messageId: fallback.messageId, attachmentLinks: [], attachmentFileIds: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2b. Create a TG Reply Threads record so agent replies to this exact
  //     Telegram message can be tracked in the dashboard. Optional feature —
  //     skipped silently until THREADS_KV is bound (see wrangler.toml).
  let threadId = null;
  if (env.THREADS_KV) {
    try {
      const title = fieldMap.issueType ? `${meta.name} — ${fieldMap.issueType}` : `${meta.name} — ${brand.name}`;
      const summary = fields
        .filter((f) => f.value && !["issueType"].includes(f.key))
        .slice(0, 6)
        .map((f) => ({ label: f.label, value: f.value }));
      const thread = await createThread(env, {
        module: moduleId,
        moduleName: meta.name,
        icon: meta.emoji,
        accent: meta.accent,
        brand: brand.name,
        title,
        submitter: reporter,
        chatId: route.chatId,
        topicId: route.topicId,
        rootMessageId: tgResult.messageId,
        rootText: text,
        hasMedia: Array.isArray(attachments) && attachments.length > 0,
        attachmentFileIds: tgResult.attachmentFileIds || [],
        summary,
      });
      threadId = thread.id;
    } catch {
      // Non-fatal — the Telegram message and sheet row are already the
      // source of truth; the reply-tracking record is a nice-to-have.
    }
  }

  // 2. Optionally log to the brand's Google Sheet (fire-and-await, but don't
  //    fail the whole request if the sheet write fails — Telegram already has it).
  let sheetLogged = false;
  let sheetError = null;
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  const sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && promoConfig)
    : !!(RECORD_TO_SHEET[moduleId] && brand.sheetId);
  if (sheetAttempted) {
    try {
      if (moduleId === "promotion_request") {
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        await appendRowByColumns(env, promoConfig.sheetId, promoConfig.tab, promoConfig.startColumn, values);
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
            await appendRowByColumns(env, brand.sheetId, layout.tab, layout.startColumn, values);
          } else {
            const row = {
              timestamp,
              brand: brand.name,
              reporter,
              ...Object.fromEntries(fields.map((f) => [f.key, f.value])),
              attachments: (attachments || []).map((a) => a.name).join(", "),
            };
            await appendRowToSheet(env, brand.sheetId, moduleId, row);
          }
        }
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  return json({
    ok: true,
    telegramMessageId: tgResult.messageId,
    threadId,
    sheetAttempted,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  });
}

// Promotion Request: plain "Particular information" list (no emoji/header
// styling, matches the reference format exactly). `key` can be a field key,
// "brand", "pic", or { fixed: "..." } for an always-the-same value.
function buildPromotionRequestMessage(rows, { brandName, fieldMap, reporter }) {
  const lines = ["<b>Particular information</b>"];
  rows.forEach((item) => {
    let value;
    if (typeof item.key === "object") value = item.key.fixed;
    else if (item.key === "brand") value = brandCurrencyLabel(brandName);
    else if (item.key === "pic") value = reporter;
    else value = fieldMap[item.key];
    lines.push(`<b>${escapeHtml(item.label)}:</b> ${escapeHtml(value || "-")}`);
  });
  return lines.join("\n");
}

function resolveColumnValues(columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks }) {
  return columns.map((col) => {
    if (col === null) return "-";
    if (typeof col === "string") {
      if (col === "brand") return brand.name || "-";
      if (col === "pic") return reporter || "-";
      if (col === "screenshotLink") return (screenshotLink || attachmentLinks.join(", ")) || "-";
      if (col === "dateFormatted") return formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date) || "-";
      return fieldMap[col] || "-";
    }
    // { details: ["remark", "issueDetails"] } — first non-empty field wins
    const [, fallbackKeys] = Object.entries(col)[0];
    for (const key of fallbackKeys) {
      if (fieldMap[key]) return fieldMap[key];
    }
    return "-";
  });
}

function resolveAutoRemark(fieldMap) {
  for (const triggerField of ["issueType", "accountStatus", "cancelType"]) {
    const table = RISK_ISSUE_AUTO_REMARKS[triggerField];
    const match = table && table[fieldMap[triggerField]];
    if (match) return match;
  }
  return null;
}

function resolveSheetLayout(entry, fieldMap) {
  if (!entry) return null;
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    return entry.layouts[selectorValue] || entry.layouts.default || null;
  }
  return entry;
}

function resolveTemplate(entry, fieldMap) {
  if (!entry) return null;
  if (Array.isArray(entry)) return { rows: entry, spacing: "tight", emptyPlaceholder: "-" };
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    const chosen = entry.templates[selectorValue] || entry.templates.default;
    return resolveTemplate(chosen, fieldMap);
  }
  return { rows: entry.rows, spacing: entry.spacing || "tight", emptyPlaceholder: entry.emptyPlaceholder ?? "-", header: entry.header || null };
}

function resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink }) {
  if (typeof item.key !== "string") {
    const [, fallbackKeys] = Object.entries(item.key)[0];
    return fallbackKeys.map((k) => fieldMap[k]).find((v) => v);
  }
  if (item.key === "brand") return brandCurrencyLabel(brandName);
  if (item.key === "screenshotLink") return screenshotLink;
  if (item.key === "pic") return reporter;
  if (item.key === "dateShift") return formatDateShift(fieldMap.reportDate, fieldMap.shift);
  if (item.key === "autoRemark") return resolveAutoRemark(fieldMap);
  if (item.key === "submittedBy") return reporter ? `Submitted by ${reporter}` : null;
  return fieldMap[item.key];
}

function buildMessageFromTemplate({ template, meta, brandName, fieldMap, reporter, screenshotLink }) {
  const { rows, spacing, emptyPlaceholder, header } = template;
  const lines = [];
  if (header) {
    const headerValue = header.source === "brand" ? brandName : fieldMap[header.source];
    const titleLine = header.hideValue
      ? `${meta.emoji} <b>${escapeHtml(meta.name)}</b>`
      : `${meta.emoji} <b>${escapeHtml(meta.name)} — ${escapeHtml(headerValue || "-")}</b>`;
    lines.push(titleLine);
    if (!header.noBlankAfter) lines.push("");
  }
  rows.forEach((item, i) => {
    const value = resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink });
    if (item.raw) {
      if (!value) return; // skip entirely — no placeholder line for optional raw notes
      lines.push(`${item.emoji} ${escapeHtml(value)}`);
    } else {
      lines.push(`${item.emoji} <b>${escapeHtml(item.label)}:</b> ${escapeHtml(value || emptyPlaceholder)}`);
    }
    if (spacing === "loose" && i < rows.length - 1 && !item.tight) lines.push("");
  });
  return lines.join("\n");
}

// "15/07/2026 ( Day Shift Report )☀️" — DD/MM/YYYY from the <input type=date>
// value (YYYY-MM-DD), plus the shift name and a sun/moon emoji.
function formatDateShift(isoDate, shift) {
  const formatted = formatDateDDMMYYYY(isoDate);
  if (!formatted) return "-";
  const emoji = shift === "Night Shift" ? "🌙" : "☀️";
  return `${formatted} ( ${shift || "Day Shift"} Report )${emoji}`;
}

function formatDateDDMMYYYY(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

// Used for any Risk Issue type that doesn't have its own row list in
// MESSAGE_TEMPLATE.risk_issue.templates — keeps the same visual style
// (emoji-labeled bold rows, header showing the Issue Type) without needing
// a hand-written template for all 11 issue types up front.
function buildRiskIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`⚠️ <b>Risk Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.uid || "-")}`);

  const middleFields = fields.filter((f) => !["issueType", "uid", "remark"].includes(f.key) && f.value);
  if (middleFields.length) {
    lines.push("");
    middleFields.forEach((f) => {
      const emoji = RISK_ISSUE_FIELD_EMOJI[f.key] || "🔸";
      lines.push(`${emoji} <b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`);
    });
  }

  // Only show a Remark row if this issue type's form actually had a
  // Remark field with something typed into it — several issue types
  // (Others Bonus Related Issue, VIP Level Update Issue, KYC Issues,
  // Remove Bank Account, Others Issues, Verify Bank Detail) use "Issue
  // Description" instead of "Remark" and never collect fieldMap.remark
  // at all, so this used to unconditionally print an empty "Remark: -"
  // line even when the form never asked for one.
  if (fieldMap.remark) {
    lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark)}`);
  }

  const autoNote = resolveAutoRemark(fieldMap);
  if (autoNote) lines.push("", `💬 ${escapeHtml(autoNote)}`);

  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

// Account Issue: header shows Issue Type, Brand/Username/type-specific
// fields are all grouped together (no blank lines between them), then one
// blank line before Remark and another before PIC.
function buildAccountIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`🔑 <b>Account Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.uid || "-")}`);

  fields
    .filter((f) => !["issueType", "uid", "remark"].includes(f.key) && f.value)
    .forEach((f) => {
      const style = ACCOUNT_ISSUE_FIELD_STYLE[f.key];
      const emoji = style ? style.emoji : "🔸";
      const label = style && style.label ? style.label : f.label;
      lines.push(`${emoji} <b>${escapeHtml(label)}:</b> ${escapeHtml(f.value)}`);
    });

  lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark || "-")}`);
  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

function buildMessage({ meta, brandName, reporter, fields, moduleId, fieldMap }) {
  const autoNote = moduleId === "risk_issue" ? resolveAutoRemark(fieldMap) : null;
  const lines = [
    `${meta.emoji} <b>New ${escapeHtml(meta.name)} — ${escapeHtml(brandName)}</b>`,
    "",
    ...fields
      .filter((f) => f.value)
      .map((f) => `<b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`),
    ...(autoNote ? ["", `💬 ${escapeHtml(autoNote)}`] : []),
    "",
    `🧑‍💼 Submitted by ${escapeHtml(reporter)}`,
  ];
  return lines.join("\n");
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
    return { messageId: r.messageId, attachmentLinks: [], attachmentFileIds: [] };
  }

  if (attachments.length === 1) {
    const { messageId, fileId } = await sendSingleWithCaption({ botToken, route, text, attachment: attachments[0] });
    return { messageId, attachmentLinks: [buildMessageLink(route, messageId)], attachmentFileIds: fileId ? [fileId] : [] };
  }

  const allImages = attachments.every((a) => looksLikeImage(a.type, a.name));
  if (allImages) {
    const sent = await sendMediaGroup({ botToken, route, text, attachments });
    return {
      messageId: sent[0].messageId,
      attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
      attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
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
  return {
    messageId: sent[0].messageId,
    attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
    attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
  };
}

async function sendSingleWithCaption({ botToken, route, text, attachment }) {
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
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : data.result.document?.file_id || null;
  return { messageId: data.result.message_id, fileId };
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

  attachments.forEach((att, i) => {
    const bytes = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const blob = new Blob([bytes], { type: att.type || "image/jpeg" });
    form.append(`file${i}`, blob, att.name || `photo${i}`);
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  return data.result.map((m) => ({
    messageId: m.message_id,
    fileId: m.photo?.[m.photo.length - 1]?.file_id || null,
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Business owner wants every TG-message "Platform"/"Brand" labeled ROW to
// read "<Brand> <CURRENCY>" (e.g. "Betjili PHP") — NOT the Sheet columns,
// and NOT the "New X — Brand" title/header lines, both of which stay as
// the plain brand name. Used at the three spots that render a labeled
// brand row: buildPromotionRequestMessage, resolveFieldValue (the
// MESSAGE_TEMPLATE row renderer used by QA/Risk Issue/Genie Issue/Daily
// Report), and buildAccountIssueDynamicMessage.
//
// ONE PLACE TO EDIT when reusing this project for a different currency
// market — change CURRENCY_LABEL below and every outgoing Telegram
// message updates automatically. Leave it as "" to drop the suffix
// entirely and show just the plain brand name.
const CURRENCY_LABEL = "PHP";
function brandCurrencyLabel(name) {
  return name && CURRENCY_LABEL ? `${name} ${CURRENCY_LABEL}` : name;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
