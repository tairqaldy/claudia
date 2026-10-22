// Just enough of the Telegram Bot API: send, typing indicator, long polling.
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

    send(chatId, text, { silent = false, replyTo = null } = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text: clip(text, 4000),
        disable_notification: silent,
        link_preview_options: { is_disabled: true },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
    },

    typing: (chatId) => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),

    // Long-polls forever, handing each update to onUpdate one at a time.
    async poll(onUpdate, onError = () => {}) {
      let offset = 0;
      for (;;) {
        try {
          const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
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
