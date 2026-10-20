// Бот вишлиста — Supabase Edge Function.
//
// 1. Вебхук Telegram (запросы с заголовком X-Telegram-Bot-Api-Secret-Token):
//    - chat_shared: пользователь создал или выбрал чат по кнопке «Создать чат
//      сбора» — бот делает ссылку-приглашение с заявками, привязывает чат к
//      сбору и рассылает приглашения всем участникам сбора в личку;
//    - /start c<id> в группе — то же для клиентов старше Bot API 9.6, где
//      мини-приложение открывает ссылку t.me/<бот>?startgroup=c<id>;
//    - chat_join_request: одобряет заявки участников сбора, остальные отклоняет.
// 2. Запросы мини-приложения { action: 'prepare_chat', init_data, ... } —
//    готовит кнопку для WebApp.requestChat (savePreparedKeyboardButton).
//    Подпись initData проверяет база (app.auth).
//
// Токен бота и секрет вебхука лежат в app.settings. В Supabase у функции
// должна быть выключена проверка JWT — Telegram её не присылает.
//
// Файл без зависимостей, кроме драйвера Postgres в Deno: логика в createBot()
// и handleRequest() запускается и в тестах на Node (dev/test-bot.mjs).

type Row = Record<string, unknown>;
export type Query = (text: string, params?: unknown[]) => Promise<Row[]>;
export type TelegramResult = { ok: boolean; result?: any; description?: string };
export type Telegram = (method: string, body: Record<string, unknown>) => Promise<TelegramResult>;

interface Pool {
  room_id: string;
  recipient_id: number;
  room_name: string;
  friend_name: string;
  creator_name: string;
  supporters: number[];
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
};

// Боту нужно только право приглашать: делать ссылки и одобрять заявки
const BOT_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: true,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorText(err: unknown) {
  const message = (err as { message?: string })?.message ?? String(err);
  return message.replace(/^error:\s*/i, '');
}

export function createBot({ query, telegram }: { query: Query; telegram: Telegram }) {
  const one = async (text: string, params: unknown[]) => (await query(text, params))[0] ?? null;

  async function prepareChat(body: { init_data?: string; room_id?: string; friend_id?: number }) {
    const row = await one('select app.bot_prepare_chat($1::text, $2::uuid, $3::bigint) as r', [
      body.init_data ?? '',
      body.room_id ?? null,
      String(body.friend_id ?? ''),
    ]);
    const ticket = row?.r as { request_id: number; user_id: number; friend_name: string };
    const saved = await telegram('savePreparedKeyboardButton', {
      user_id: ticket.user_id,
      button: {
        text: `Чат сбора: ${ticket.friend_name}`.slice(0, 64),
        request_chat: {
          request_id: ticket.request_id,
          chat_is_channel: false,
          bot_administrator_rights: BOT_RIGHTS,
          user_administrator_rights: BOT_RIGHTS,
          request_title: true,
        },
      },
    });
    return {
      // для WebApp.requestChat (Bot API 9.6+)
      button_id: saved.ok ? (saved.result?.id as string) : null,
      // для ссылки t.me/<бот>?startgroup=… на старых клиентах
      start_param: `c${ticket.request_id}`,
      error: saved.ok ? undefined : saved.description,
    };
  }

  async function linkChat(pool: Pool, chatId: number, creatorId: number, title?: string) {
    const name = `Сбор: ${pool.friend_name}`.slice(0, 32);
    let invite = await telegram('createChatInviteLink', { chat_id: chatId, name, creates_join_request: true });
    let guarded = true;
    if (!invite.ok) {
      // если заявки в этом чате недоступны — обычная ссылка, её видят только участники сбора
      invite = await telegram('createChatInviteLink', { chat_id: chatId, name });
      guarded = false;
    }
    if (!invite.ok) {
      await telegram('sendMessage', {
        chat_id: creatorId,
        text:
          'Не получилось привязать чат: боту нужны права администратора с правом приглашать участников. ' +
          'Выдайте их в настройках чата и нажмите «Создать чат сбора» ещё раз.',
      });
      return false;
    }

    const link = invite.result.invite_link as string;
    await query('select app.bot_save_chat($1::uuid, $2::bigint, $3::bigint, $4::text, $5::bigint)', [
      pool.room_id,
      String(pool.recipient_id),
      String(chatId),
      link,
      String(creatorId),
    ]);

    const others = pool.supporters.filter((id) => Number(id) !== Number(creatorId));
    await telegram('sendMessage', {
      chat_id: chatId,
      text:
        `🎁 Чат сбора на подарок. Кому: ${pool.friend_name} · компания «${pool.room_name}».` +
        (others.length ? `\nПриглашения отправлены участникам сбора: ${others.length}.` : '') +
        (guarded ? '\nПускаю в чат только участников сбора.' : ''),
    });

    let delivered = 0;
    for (const id of others) {
      const sent = await telegram('sendMessage', {
        chat_id: id,
        text: `${pool.creator_name} зовёт вас в чат сбора на подарок 🎁\nКому: ${pool.friend_name} · компания «${pool.room_name}»`,
        reply_markup: { inline_keyboard: [[{ text: 'Вступить в чат', url: link }]] },
      });
      if (sent.ok) delivered++;
    }

    await telegram('sendMessage', {
      chat_id: creatorId,
      text:
        `Готово! Чат${title ? ` «${title}»` : ''} привязан к сбору (кому: ${pool.friend_name}).` +
        (others.length
          ? ` Приглашения в личку: ${delivered} из ${others.length}.` +
            (delivered < others.length ? ' Остальные увидят кнопку «Открыть чат сбора» в приложении.' : '')
          : ' Новые участники сбора увидят кнопку «Открыть чат сбора» в приложении.'),
    });
    return true;
  }

  async function claim(requestId: number, fromId: number) {
    const row = await one('select app.bot_claim_chat($1::integer, $2::bigint) as p', [String(requestId), String(fromId)]);
    return (row?.p as Pool | null) ?? null;
  }

  async function handleUpdate(update: any) {
    const msg = update?.message;

    if (msg?.migrate_to_chat_id) {
      await query('select app.bot_migrate_chat($1::bigint, $2::bigint)', [String(msg.chat.id), String(msg.migrate_to_chat_id)]);
      return;
    }

    // Чат выбран или создан по кнопке из мини-приложения
    if (msg?.chat_shared) {
      const pool = await claim(msg.chat_shared.request_id, msg.from.id);
      if (!pool) {
        await telegram('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Эта кнопка устарела — нажмите «Создать чат сбора» в приложении ещё раз.',
        });
        return;
      }
      await linkChat(pool, msg.chat_shared.chat_id, msg.from.id, msg.chat_shared.title);
      return;
    }

    // Старые клиенты: бота добавили в группу по ссылке ?startgroup=c<id>
    const text = typeof msg?.text === 'string' ? msg.text : '';
    const start = /^\/start(?:@\w+)?\s+c(\d{1,10})\s*$/.exec(text);
    if (start && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
      const pool = await claim(Number(start[1]), msg.from.id);
      if (!pool) {
        await telegram('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Ссылка устарела — нажмите «Создать чат сбора» в приложении ещё раз.',
        });
        return;
      }
      await linkChat(pool, msg.chat.id, msg.from.id, msg.chat.title);
      return;
    }

    if (/^\/start\b/.test(text) && msg.chat.type === 'private') {
      await telegram('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Привет! Я бот новогоднего вишлиста 🎁 Откройте приложение кнопкой «Открыть» — там компании, вишлисты и сборы.',
      });
      return;
    }

    // Заявка в чат сбора: только участникам сбора
    const request = update?.chat_join_request;
    if (request) {
      const row = await one('select app.bot_can_join($1::bigint, $2::bigint) as ok', [
        String(request.chat.id),
        String(request.from.id),
      ]);
      await telegram(row?.ok ? 'approveChatJoinRequest' : 'declineChatJoinRequest', {
        chat_id: request.chat.id,
        user_id: request.from.id,
      });
    }
  }

  return { prepareChat, handleUpdate };
}

export async function handleRequest(req: Request, deps: { bot: ReturnType<typeof createBot>; secret?: string }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: true });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Пустой запрос' }, 400);

  // Мини-приложение: подпись initData проверяет база
  if (body.action === 'prepare_chat') {
    try {
      return json(await deps.bot.prepareChat(body));
    } catch (err) {
      return json({ error: errorText(err) }, 400);
    }
  }

  // Telegram
  if (!deps.secret || req.headers.get('x-telegram-bot-api-secret-token') !== deps.secret) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    await deps.bot.handleUpdate(body);
  } catch (err) {
    // отвечаем 200, чтобы Telegram не повторял одно и то же обновление
    console.error('update failed', err);
  }
  return new Response('ok');
}

// --- запуск в Supabase Edge Runtime --------------------------------------------
if ('Deno' in globalThis) {
  const Deno = (globalThis as any).Deno;
  const { default: postgres } = await import('npm:postgres@3.4.5');
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { prepare: false });
  const query: Query = (text, params = []) => sql.unsafe(text, params as never[]);

  Deno.serve(async (req: Request) => {
    const rows = await query("select key, value from app.settings where key in ('bot_token', 'webhook_secret')");
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, string>;
    const telegram: Telegram = async (method, body) => {
      const res = await fetch(`https://api.telegram.org/bot${settings.bot_token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    return handleRequest(req, { bot: createBot({ query, telegram }), secret: settings.webhook_secret });
  });
}
