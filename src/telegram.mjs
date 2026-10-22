// Just enough of the Telegram Bot API: messages, buttons, photos, long polling.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { clip, sleep } from "./util.mjs";

export class TelegramError extends Error {
  constructor(method, body) {
    super(`telegram ${method}: ${body.description ?? "request failed"}`);
    this.code = body.error_code;
    this.retryAfter = body.parameters?.retry_after;
  }
}

export function createTelegram(token) {
  async function call(method, params = {}, timeoutMs = 15_000) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({ ok: false, error_code: res.status }));
    if (!body.ok) throw new TelegramError(method, body);
    return body.result;
  }

  return {
    call,
    me: () => call("getMe"),

    // markup: inline buttons ({ inline_keyboard }) or { force_reply: true } to prompt for an answer
    send(chatId, text, { silent = false, replyTo = null, markup = null } = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text: clip(text, 4000),
        disable_notification: silent,
        link_preview_options: { is_disabled: true },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        ...(markup ? { reply_markup: markup } : {}),
      });
    },

    edit(chatId, messageId, text, markup = { inline_keyboard: [] }) {
      return call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: clip(text, 4000),
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      }).catch(() => {});
    },

    setButtons: (chatId, messageId, markup = { inline_keyboard: [] }) =>
      call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup }).catch(() => {}),

    answerButton: (queryId, text) =>
      call("answerCallbackQuery", { callback_query_id: queryId, ...(text ? { text } : {}) }).catch(() => {}),

    react: (chatId, messageId, emoji) =>
      call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }).catch(() => {}),

    async sendPhoto(chatId, filePath, caption = "") {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) form.append("caption", clip(caption, 1000));
      form.append("photo", new Blob([readFileSync(filePath)], { type: "image/jpeg" }), basename(filePath));
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      const body = await res.json().catch(() => ({ ok: false, error_code: res.status }));
      if (!body.ok) throw new TelegramError("sendPhoto", body);
      return body.result;
    },

    async download(fileId) {
      const file = await call("getFile", { file_id: fileId });
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new TelegramError("download", { description: `HTTP ${res.status}` });
      return Buffer.from(await res.arrayBuffer());
    },

    typing: (chatId) => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),

    // Long-polls forever, handing each update to onUpdate one at a time.
    async poll(onUpdate, onError = () => {}) {
      let offset = 0;
      for (;;) {
        try {
          const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 65_000);
          for (const u of updates) {
            offset = u.update_id + 1;
            await onUpdate(u).catch(onError);
          }
        } catch (err) {
          onError(err);
          // 401: bad token, 409: another process is polling this bot. Back off instead of hammering.
          await sleep(err.code === 401 || err.code === 409 ? 60_000 : (err.retryAfter ?? 5) * 1000);
        }
      }
    },
  };
}
