/**
 * telegram-webhook.js
 *
 * Register this URL with Telegram once (from your own machine, not this
 * app — Telegram calls it, we don't call ourselves):
 *
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d "url=https://inrtg-control.pages.dev/api/telegram-webhook" \
 *     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *     -d "allowed_updates=[\"message\"]"
 *
 * `TELEGRAM_WEBHOOK_SECRET` is a string you make up yourself (any random
 * value works) and set as a Cloudflare secret with that same name — it's
 * how we verify a request genuinely came from Telegram and not some rando
 * hitting this URL directly.
 *
 * Every message posted in the bot's groups (agent replies included) is
 * delivered here. Only a genuine, explicit reply gets matched — but that
 * now includes chains: a reply to our root ticket message, a reply to
 * THAT reply (e.g. someone @-tags another team who then replies), and so
 * on, as long as each link in the chain is an explicit reply to a message
 * we've already recorded. If that ticket was already marked Solved, an
 * explicit reply reopens it, since replying to it on purpose is a
 * deliberate signal. Anything else — a plain message typed in the topic
 * with no reply, Telegram's auto-attached "reply to the topic root" that
 * isn't a real reply, or a reply to some message outside this chain — is
 * intentionally ignored rather than guessed at, so a message never lands
 * on the wrong ticket.
 */
import { findThreadIdByMessage, appendMessage } from "../_shared/threads.js";

export async function onRequestPost({ request, env }) {
  // Verify the request really came from Telegram.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok"); // Always 200 quickly — Telegram retries on non-2xx.
  }

  try {
    await handleUpdate(env, update);
  } catch {
    // Swallow errors — a broken reply-sync should never make Telegram think
    // the webhook is unhealthy and start retrying/backing off.
  }
  return new Response("ok");
}

async function handleUpdate(env, update) {
  if (!env.THREADS_KV) return;
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const hasContent = msg.text || msg.caption || msg.photo || msg.document || msg.video || msg.voice || msg.sticker;
  if (!hasContent) return; // Nothing worth recording (join/leave/pin service messages, etc.)

  const replyTarget = msg.reply_to_message;
  const isAutoTopicReply = replyTarget && msg.is_topic_message && msg.message_thread_id === replyTarget.message_id;
  const isGenuineReply = replyTarget && !isAutoTopicReply;
  if (!isGenuineReply) return; // Not a deliberate reply — ignore, don't guess.

  const threadId = await findThreadIdByMessage(env, msg.chat.id, replyTarget.message_id);
  if (!threadId) return; // Reply to something we're not tracking.

  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";

  // Incoming photo/document/video/voice/sticker from someone replying
  // IN Telegram itself (not from our own website's reply box — that's a
  // separate path, see functions/api/threads/[id].js's "reply" action).
  // This used to just hardcode the literal text "(attachment)" with
  // nothing else recorded — no file_id, nothing — so there was never any
  // way to actually view what was sent, even after the dashboard grew
  // the ability to preview OUR OWN outgoing attachments. Same fix,
  // applied to the other direction: capture Telegram's own file_id here
  // too, so the same /api/attachment/[fileId].js live-proxy + lightbox
  // (public/threads.html's viewAttachment()) can show it.
  let attachmentFileId = null;
  let attachmentName = null;
  if (msg.photo && msg.photo.length) {
    attachmentFileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    attachmentName = "photo.jpg";
  } else if (msg.document) {
    attachmentFileId = msg.document.file_id;
    attachmentName = msg.document.file_name || "document";
  } else if (msg.video) {
    attachmentFileId = msg.video.file_id;
    attachmentName = msg.video.file_name || "video.mp4";
  } else if (msg.voice) {
    attachmentFileId = msg.voice.file_id;
    attachmentName = "voice message";
  } else if (msg.sticker) {
    attachmentFileId = msg.sticker.file_id;
    attachmentName = "sticker";
  }

  await appendMessage(env, threadId, {
    from: name,
    handle: msg.from?.username ? `@${msg.from.username}` : null,
    text: msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "(attachment)"),
    hasAttachment: !!attachmentFileId,
    attachmentName,
    attachmentFileId,
    ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    self: false,
    messageId: msg.message_id,
    replyToMessageId: replyTarget.message_id,
  });
}
