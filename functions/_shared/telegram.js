/**
 * telegram.js  (SERVER-ONLY)
 *
 * Small shared helper for sending a plain Telegram message from anywhere
 * in this project — used by the login IP-alert feature (see
 * api/auth/login.js). Deliberately minimal: no attachments, no reply
 * threading, just "send this text to this chat/topic." submit.js and
 * threads/[id].js have their own richer Telegram senders (attachments,
 * edits, deletes) that predate this file and weren't refactored to use
 * it — this is only for new, simple, fire-and-forget notifications.
 */

// Sends a message and never throws — callers that fire this from
// `context.waitUntil()` (so it doesn't add latency to the actual
// response) have nowhere to catch a rejection anyway, so this swallows
// its own errors and just returns false on failure.
export async function sendTelegramMessage(env, { chatId, topicId, text }) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false; // not configured yet — silently skip
  try {
    const payload = { chat_id: chatId, text, parse_mode: "HTML" };
    if (topicId) payload.message_thread_id = Number(topicId);
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    return !!(data && data.ok);
  } catch {
    return false;
  }
}
