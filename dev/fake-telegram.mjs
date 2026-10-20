// Поддельный Bot API для тестов и эмулятора: запоминает вызовы и отвечает
// так же, как настоящий Telegram. Пользователи из blockedPm не разрешили
// боту писать — sendMessage им возвращает 403, как в жизни.
export function createFakeTelegram({ blockedPm = [] } = {}) {
  const calls = [];
  const buttons = new Map();
  let seq = 0;

  async function telegram(method, body) {
    calls.push({ method, body });
    switch (method) {
      case 'savePreparedKeyboardButton': {
        const id = `prepared_${++seq}`;
        buttons.set(id, { userId: body.user_id, button: body.button });
        return { ok: true, result: { id } };
      }
      case 'createChatInviteLink':
        return { ok: true, result: { invite_link: `https://t.me/+demoPoolChat${++seq}`, name: body.name } };
      case 'sendMessage':
        if (blockedPm.includes(Number(body.chat_id))) {
          return { ok: false, description: "Forbidden: bot can't initiate conversation with a user" };
        }
        return { ok: true, result: { message_id: ++seq } };
      default:
        return { ok: true, result: true };
    }
  }

  return {
    telegram,
    calls,
    buttons,
    /** Обновление, которое Telegram пришлёт боту, когда пользователь создаст чат по кнопке */
    chatSharedUpdate(buttonId, { chatId = -1001000000000 - seq, title } = {}) {
      const prepared = buttons.get(buttonId);
      if (!prepared) throw new Error(`unknown prepared button ${buttonId}`);
      return {
        update_id: ++seq,
        message: {
          message_id: ++seq,
          from: { id: prepared.userId, is_bot: false, first_name: 'User' },
          chat: { id: prepared.userId, type: 'private' },
          chat_shared: {
            request_id: prepared.button.request_chat.request_id,
            chat_id: chatId,
            title: title ?? prepared.button.text,
          },
        },
      };
    },
  };
}
