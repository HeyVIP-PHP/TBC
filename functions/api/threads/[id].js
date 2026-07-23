/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, password?, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: no password — any agent can toggle from the dashboard.
 *   - delete: requires `password` (deletes our tracking record only —
 *     Telegram messages and the Google Sheet row are untouched).
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot { password }: deletes the original ticket message from
 *     Telegram (password-gated — this removes it from the group for real).
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId, password }: deletes one of our own past
 *     replies from Telegram (password-gated).
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 */
/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: any logged-in agent who can see this thread's brand.
 *   - delete: untracks our record (Telegram/Sheet untouched). No separate
 *     password anymore — being logged in as an account that can see this
 *     brand is the authorization; `by` is filled from that account.
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot: deletes the original ticket message from Telegram.
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId }: deletes one of our own past replies.
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 *
 *   Every action requires a logged-in account (X-Agent-Token) that's
 *   allowed to see this thread's brand — see _shared/accounts.js.
 *   A thread outside an account's allowed brands 404s exactly like it
 *   doesn't exist, same as it's filtered out of the sidebar list.
 */
import {
  getThread, setSolved, softDeleteThread, appendMessage,
  updateRootText, markRootRecalled, editMessageInThread, removeMessageFromThread,
  logDeletion,
} from "../../_shared/threads.js";
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";

export async function onRequestGet({ request, env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  const thread = await getThread(env, params.id);
  if (!thread || thread.deleted || !canSeeBrand(account, thread.brand)) return json({ ok: false, error: "Not found." }, 404);
  return json({ ok: true, thread });
}

// Top-level safety net — same reasoning as submit.js: everything below
// already handles its own expected failure modes (bad JSON, Telegram
// errors via callTelegram's tg.ok checks) with a clean { ok:false, error }
// response, but a handful of actions (editRoot/recallRoot/editReply/
// recallReply) call the Telegram API directly without their own try/catch
// — a network hiccup or a non-JSON response from Telegram would otherwise
// throw uncaught and come back as a raw platform error instead of JSON.
// This outer catch is the guarantee that never happens.
export async function onRequestPost(context) {
  try {
    return await handleThreadAction(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleThreadAction({ request, env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { action } = body || {};
  const id = params.id;

  // Every action operates on an existing thread the account must be
  // allowed to see — check once up front instead of in every branch.
  const existingThread = await getThread(env, id);
  if (!existingThread || existingThread.deleted || !canSeeBrand(account, existingThread.brand)) {
    return json({ ok: false, error: "Not found." }, 404);
  }

  if (action === "solve" || action === "unsolve") {
    const thread = await setSolved(env, id, action === "solve");
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true, thread });
  }

  if (action === "delete") {
    const before = existingThread;
    const thread = await softDeleteThread(env, id);
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    await logDeletion(env, {
      type: "delete-thread",
      threadId: id,
      threadTitle: before?.title || thread.title,
      brand: before?.brand || thread.brand,
      content: `Ticket + ${thread.messages?.length || 0} message(s) untracked (Telegram/Sheet untouched)`,
      by: account.username,
    });
    return json({ ok: true });
  }

  if (action === "reply") {
    const text = (body.text || "").trim();
    const attachment = body.attachment; // { name, type, dataUrl } | undefined
    const replyToMessageId = body.replyToMessageId || null;
    if (!text && !attachment) return json({ ok: false, error: "Reply text is empty." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;

    let messageId;
    let attachmentFileId = null;
    try {
      if (attachment) {
        const sent = await sendTelegramAttachment(env, thread, text, attachment, replyToMessageId);
        messageId = sent.messageId;
        attachmentFileId = sent.fileId;
      } else {
        messageId = await sendTelegramText(env, thread, text, replyToMessageId);
      }
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }

    // Reply attachments used to only ever go to Telegram — nothing about
    // them was saved on our own side, so there was no way to view one
    // again from this dashboard afterward (the sidebar just showed a
    // plain, unclickable "📎 attachment" label forever). Deliberately NOT
    // storing a copy anywhere (business owner's call, to avoid using any
    // R2 storage for this) — instead, just remember Telegram's own
    // `file_id` for the upload (returned by sendPhoto/sendDocument above,
    // valid for as long as the file exists on Telegram's servers). The
    // dashboard fetches the actual bytes live, on demand, only when
    // someone actually clicks to view it — see
    // functions/api/attachment/[fileId].js, which resolves that file_id
    // through Telegram's getFile + file download endpoints and proxies
    // the bytes back (never exposing TELEGRAM_BOT_TOKEN to the browser —
    // the token only ever appears in this server-side proxy's own
    // outbound requests, same reasoning as why R2 files get served
    // through /api/screenshot/<key> instead of a raw bucket URL).
    const updated = await appendMessage(env, id, {
      from: account.username,
      handle: null,
      text: text || `📎 ${attachment.name}`,
      hasAttachment: !!attachment,
      attachmentName: attachment ? attachment.name : null,
      attachmentFileId,
      ts: new Date().toISOString(),
      self: true,
      delivered: true,
      messageId,
      replyToMessageId: replyToMessageId || null,
    });
    return json({ ok: true, thread: updated });
  }

  if (action === "editRoot") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "New text is empty." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(env, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await updateRootText(env, id, text);
    return json({ ok: true, thread: updated });
  }

  if (action === "recallRoot") {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    const tg = await callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: thread.rootMessageId });
    if (!tg.ok) return json({ ok: false, error: telegramDeleteError(tg) }, 502);

    const updated = await markRootRecalled(env, id);
    await logDeletion(env, {
      type: "recall-root",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: thread.rootText || "(no text)",
      by: account.username,
    });
    return json({ ok: true, thread: updated });
  }

  if (action === "editReply") {
    const text = (body.text || "").trim();
    const messageId = body.messageId;
    if (!text || !messageId) return json({ ok: false, error: "Missing text or messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const tg = await callTelegram(env, "editMessageText", { chat_id: existingThread.chatId, message_id: messageId, text, parse_mode: "HTML" });
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await editMessageInThread(env, id, messageId, text);
    return json({ ok: true, thread: updated });
  }

  if (action === "recallReply") {
    const messageId = body.messageId;
    if (!messageId) return json({ ok: false, error: "Missing messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    const tg = await callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: messageId });
    if (!tg.ok) return json({ ok: false, error: telegramDeleteError(tg) }, 502);

    const recalledMsg = thread.messages.find((m) => m.self && m.messageId === messageId);
    const updated = await removeMessageFromThread(env, id, messageId);
    await logDeletion(env, {
      type: "recall-reply",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: recalledMsg?.text || "(no text)",
      by: account.username,
    });
    return json({ ok: true, thread: updated });
  }

  return json({ ok: false, error: `Unknown action "${action}".` }, 400);
}

async function callTelegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendTelegramText(env, thread, text, replyToMessageId) {
  const payload = { chat_id: thread.chatId, text, reply_to_message_id: replyToMessageId || thread.rootMessageId };
  if (thread.topicId) payload.message_thread_id = thread.topicId;
  const data = await callTelegram(env, "sendMessage", payload);
  if (!data.ok) throw new Error(data.description || "Telegram send failed.");
  return data.result.message_id;
}

// Sends a screenshot/PDF attached to a reply, same base64 → Blob approach
// submit.js already uses for the original ticket's attachments.
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

async function sendTelegramAttachment(env, thread, text, attachment, replyToMessageId) {
  const { name, type, dataUrl } = attachment;
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const isImage = looksLikeImage(type, name);
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";

  const form = new FormData();
  form.append("chat_id", thread.chatId);
  if (thread.topicId) form.append("message_thread_id", String(thread.topicId));
  form.append("reply_to_message_id", String(replyToMessageId || thread.rootMessageId));
  form.append(field, blob, name || "attachment");
  if (text) form.append("caption", text);

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram send failed.");

  // sendPhoto returns an ARRAY of sizes (Telegram auto-generates several
  // resolutions) — the last one is the largest/original-quality version,
  // which is the one worth keeping. sendDocument returns a single object
  // instead, no array. Either way, this file_id is what
  // functions/api/attachment/[fileId].js needs later to fetch the actual
  // bytes on demand — see the comment where this function is called for
  // why nothing is stored/uploaded anywhere at send time.
  const fileId = isImage
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : data.result.document?.file_id || null;

  return { messageId: data.result.message_id, fileId };
}

// Telegram's own wording is fairly technical — translate the common cases
// into something an agent can actually act on.
function telegramEditError(tg) {
  const desc = tg.description || "";
  if (/message is not modified/i.test(desc)) return "That's already the current text.";
  if (/message can't be edited|MESSAGE_ID_INVALID/i.test(desc)) return "Telegram won't let this message be edited anymore (likely too old, or it was sent as an album).";
  return desc || "Edit failed.";
}
function telegramDeleteError(tg) {
  const desc = tg.description || "";
  if (/message to delete not found/i.test(desc)) return "Already gone from Telegram (maybe someone deleted it manually).";
  if (/message can't be deleted/i.test(desc)) return "Telegram won't let this be deleted anymore — it's likely older than 48 hours.";
  return desc || "Recall failed.";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
