// Бот вишлиста — Supabase Edge Function.
//
// 1. Вебхук Telegram (запросы с заголовком X-Telegram-Bot-Api-Secret-Token):
//    - chat_shared: пользователь создал или выбрал чат по кнопке «Создать чат
//      сбора» — бот делает ссылку-приглашение с заявками, привязывает чат к
//      сбору и рассылает приглашения всем участникам сбора в личку;
//    - /start c<id> в группе — то же для клиентов старше Bot API 9.6, где
//      мини-приложение открывает ссылку t.me/<бот>?startgroup=c<id>;
//    - chat_join_request: одобряет заявки участников сбора, остальные отклоняет.
// 2. Запросы мини-приложения (подпись initData проверяет база, app.auth):
//    - { action: 'prepare_chat' } — кнопка для WebApp.requestChat
//      (savePreparedKeyboardButton);
//    - { action: 'preview_link', url } — название, цена и фото товара по ссылке
//      (Open Graph, schema.org Product), чтобы не заполнять подарок вручную.
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
export type FetchUrl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface LinkPreview {
  title: string | null;
  price: number | null;
  currency: string | null;
  /** фото товара как data URL — браузер не может скачать его сам из-за CORS */
  image: string | null;
}

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

// --- превью ссылки --------------------------------------------------------------

const MAX_PAGE_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 4_000_000;
// Так представляется Telegram, когда строит превью ссылок: многие магазины
// отдают ему метатеги даже там, где обычных ботов не пускают
const PREVIEW_UA = 'TelegramBot (like TwitterBot)';

function decodeEntities(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cleanText(text: string | undefined | null, max: number) {
  if (!text) return null;
  const clean = decodeEntities(text).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/[\s\u00a0\u202f]/g, '');
  // «1.234.567,00», «1,234,567.00», «1234567» → целое число
  const m = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(raw.replace(/[^\d.,]/g, ''));
  if (!m) return null;
  const whole = Number(m[1].replace(/[.,]/g, ''));
  const value2 = whole + (m[2] ? Number(`0.${m[2]}`) : 0);
  return Number.isFinite(value2) && value2 > 0 ? Math.round(value2) : null;
}

/** Метатеги и schema.org Product со страницы товара. */
export function parseProductPage(html: string, pageUrl: string) {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const a of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }

  // JSON-LD: ищем Product и его offers
  let ld: { title?: string; image?: string; price?: unknown; currency?: string } = {};
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack: unknown[] = [JSON.parse(block[1].trim())];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          stack.push(...node);
        } else if (node && typeof node === 'object') {
          const o = node as Record<string, any>;
          const types = ([] as unknown[]).concat(o['@type'] ?? []).map(String);
          if (types.includes('Product')) {
            const offers = ([] as any[]).concat(o.offers ?? [])[0] ?? {};
            const image = ([] as any[]).concat(o.image ?? [])[0];
            ld = {
              title: o.name,
              image: typeof image === 'string' ? image : image?.url,
              price: offers.price ?? offers.lowPrice ?? offers.priceSpecification?.price,
              currency: offers.priceCurrency ?? offers.priceSpecification?.priceCurrency,
            };
            stack.length = 0;
            break;
          }
          if (o['@graph']) stack.push(o['@graph']);
        }
      }
    } catch {
      // битый JSON-LD — пропускаем
    }
    if (ld.title) break;
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = cleanText(ld.title ?? meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 120);
  const imageRaw = ld.image ?? meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image');
  let image: string | null = null;
  if (imageRaw) {
    try {
      image = new URL(decodeEntities(imageRaw), pageUrl).toString();
    } catch {
      image = null;
    }
  }
  const price = parsePrice(
    ld.price ?? meta.get('product:price:amount') ?? meta.get('og:price:amount') ?? meta.get('price'),
  );
  const currency =
    (ld.currency ?? meta.get('product:price:currency') ?? meta.get('og:price:currency') ?? meta.get('pricecurrency') ?? '')
      .toUpperCase()
      .trim() || null;
  return { title, image, price, currency };
}

/** Только публичные http(s)-адреса: не даём ходить боту во внутренние сети. */
export function publicUrl(raw: unknown): URL | null {
  let url: URL;
  try {
    const text = String(raw ?? '').trim();
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\[/.test(host) ||
    /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) && /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(host)
  ) {
    return null;
  }
  return url;
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, out.length - offset), offset);
    offset += c.length;
    if (offset >= out.length) break;
  }
  return out;
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function errorText(err: unknown) {
  const message = (err as { message?: string })?.message ?? String(err);
  return message.replace(/^error:\s*/i, '');
}

export function createBot({
  query,
  telegram,
  fetchUrl = (url, init) => fetch(url, { ...init, redirect: 'follow' }),
}: {
  query: Query;
  telegram: Telegram;
  fetchUrl?: FetchUrl;
}) {
  const one = async (text: string, params: unknown[]) => (await query(text, params))[0] ?? null;

  async function previewLink(body: { init_data?: string; url?: string }): Promise<LinkPreview> {
    // только для пользователей мини-приложения: бот не должен быть открытым прокси
    await one('select app.auth($1::text) as id', [body.init_data ?? '']);
    const url = publicUrl(body.url);
    if (!url) throw new Error('Это не похоже на ссылку на товар');

    const headers = { 'User-Agent': PREVIEW_UA, 'Accept-Language': 'ru,en;q=0.8', Accept: 'text/html,*/*;q=0.5' };
    const page = await fetchUrl(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
    if (!page.ok) throw new Error(`Магазин не отдал страницу (${page.status}) — заполните вручную`);
    const bytes = await readLimited(page, MAX_PAGE_BYTES);
    const html = bytes ? new TextDecoder().decode(bytes) : '';
    const found = parseProductPage(html, page.url || url.toString());

    let image: string | null = null;
    const imageUrl = found.image ? publicUrl(found.image) : null;
    if (imageUrl) {
      try {
        const res = await fetchUrl(imageUrl.toString(), {
          headers: { 'User-Agent': PREVIEW_UA, Accept: 'image/*' },
          signal: AbortSignal.timeout(8000),
        });
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (res.ok && /^image\/(jpeg|png|webp|gif|avif)$/.test(type)) {
          const data = await readLimited(res, MAX_IMAGE_BYTES);
          if (data && data.length < MAX_IMAGE_BYTES) image = `data:${type};base64,${toBase64(data)}`;
        }
      } catch {
        // без фото — тоже хорошо
      }
    }
    return { title: found.title, price: found.price, currency: found.currency, image };
  }

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

  return { prepareChat, previewLink, handleUpdate };
}

export async function handleRequest(req: Request, deps: { bot: ReturnType<typeof createBot>; secret?: string }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: true });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Пустой запрос' }, 400);

  // Мини-приложение: подпись initData проверяет база
  if (body.action === 'prepare_chat' || body.action === 'preview_link') {
    try {
      return json(body.action === 'prepare_chat' ? await deps.bot.prepareChat(body) : await deps.bot.previewLink(body));
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
