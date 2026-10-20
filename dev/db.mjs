// Локальная копия бэкенда для разработки, тестов и демо: настоящий Postgres
// (PGlite, WASM) с той же миграцией, что уходит в Supabase, и вызовом RPC от
// роли anon — так же, как это делает PostgREST в Supabase.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_BOT_TOKEN = '7000000001:AAlocal-emulator-test-token-not-real';

export const PERSONAS = {
  1001: { id: 1001, first_name: 'Алиса', last_name: 'Смирнова', username: 'alice_snow' },
  1002: { id: 1002, first_name: 'Миша', last_name: 'Котов', username: 'misha_k' },
  1003: { id: 1003, first_name: 'Оля', last_name: 'Белова', username: 'olya_b' },
  1004: { id: 1004, first_name: 'Катя', last_name: 'Иванова', username: 'katya_iv' },
  1005: { id: 1005, first_name: 'Макс', last_name: 'Орлов', username: 'max_orlov' },
  1006: { id: 1006, first_name: 'Ирина', last_name: 'Соколова', username: 'irina_s' },
  1007: { id: 1007, first_name: 'Пётр', last_name: 'Лебедев', username: 'petr_l' },
  1008: { id: 1008, first_name: 'Гость', last_name: 'Извне', username: 'stranger' },
};

export async function createDb() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // Роли, которые в Supabase уже есть
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
  `);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(join(dir, file), 'utf8'));
  }
  await db.query(
    `insert into app.settings (key, value) values ('bot_token', $1)
     on conflict (key) do update set value = excluded.value`,
    [TEST_BOT_TOKEN],
  );
  return db;
}

/** Подписывает initData так же, как это делает Telegram. */
export function signInitData(user, { token = TEST_BOT_TOKEN, authDate, extra = {} } = {}) {
  const params = new URLSearchParams({
    query_id: `AAH${user.id}local`,
    user: JSON.stringify({ language_code: 'ru', allows_write_to_pm: true, ...user }),
    auth_date: String(authDate ?? Math.floor(Date.now() / 1000)),
    ...extra,
  });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}

export class RpcError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

// PostgREST принимает JSON-массив для параметра-массива; PGlite нужен литерал
const toParam = (v) =>
  Array.isArray(v) ? `{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}` : v;

/** Вызов public.<fn>(arg => value, ...) от роли anon, как POST /rest/v1/rpc/<fn>. */
export async function callRpc(db, fn, args = {}) {
  if (!IDENT.test(fn) || !Object.keys(args).every((k) => IDENT.test(k))) {
    throw new RpcError('Bad function or argument name', 'PGRST202', 404);
  }
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`;
  try {
    return await db.transaction(async (tx) => {
      await tx.exec('set local role anon');
      const { rows } = await tx.query(sql, keys.map((k) => toParam(args[k])));
      return rows[0]?.result ?? null;
    });
  } catch (err) {
    const code = err.code ?? 'XX000';
    const status = code.startsWith('28') ? 403 : code === '42501' ? 401 : code === '42883' ? 404 : 400;
    throw new RpcError(err.message, code, status);
  }
}

export const DEMO_IMAGES_DIR = join(ROOT, 'dev', 'demo-images');

export function demoImage(name) {
  return `data:image/jpeg;base64,${readFileSync(join(DEMO_IMAGES_DIR, `${name}.jpg`)).toString('base64')}`;
}

/** Код приглашения демо-компании — для ссылки в эмуляторе и видео */
export const DEMO_INVITE = 'nyfriends2027';

/**
 * Демо-данные: компания «Друзья · Новый год» в донгах, где уже собирают
 * Алисе, и отдельная «Работа» в рублях — чтобы было видно, что компании
 * друг друга не видят.
 */
export async function seedDemo(db) {
  const as = (id) => signInitData(PERSONAS[id]);
  const gifts = {};

  const createRoom = async (owner, name, currency, code) => {
    const room = await callRpc(db, 'wl_create_room', { p_init_data: as(owner), p_name: name, p_currency: currency });
    if (code) await db.query('update app.rooms set invite_code = $1 where id = $2', [code, room.id]);
    return { ...room, invite_code: code ?? room.invite_code };
  };
  const join = (user, room) => callRpc(db, 'wl_join_room', { p_init_data: as(user), p_invite_code: room.invite_code });

  const addGift = async (room, owner, emoji, title, price, link = null, image = null, extra = {}) => {
    const g = await callRpc(db, 'wl_save_gift', {
      p_init_data: as(owner),
      p_room_id: room.id,
      p_gift_id: null,
      p_title: title,
      p_price: price,
      p_emoji: emoji,
      p_link: link,
      p_note: extra.note ?? null,
      p_must_have: extra.mustHave ?? false,
    });
    gifts[title] = g.id;
    if (image) {
      await callRpc(db, 'wl_set_gift_image', { p_init_data: as(owner), p_gift_id: g.id, p_image: demoImage(image) });
    }
    return g;
  };
  const pledge = (room, from, to, amount) =>
    callRpc(db, 'wl_set_pledge', { p_init_data: as(from), p_room_id: room.id, p_friend_id: to, p_amount: amount });
  const vote = (room, from, to, title) =>
    callRpc(db, 'wl_vote', { p_init_data: as(from), p_room_id: room.id, p_friend_id: to, p_gift_id: gifts[title], p_on: true });

  // --- Друзья · Новый год (VND) ---
  const friends = await createRoom(1001, 'Друзья · Новый год', 'VND', DEMO_INVITE);
  for (const id of [1002, 1003, 1004]) await join(id, friends);

  await addGift(friends, 1001, '📚', 'Книга «Мастер и Маргарита», подарочное издание', 350000, null, 'book');
  await addGift(friends, 1001, '🧣', 'Тёплый плед с оленями', 890000, null, 'plaid', { note: 'Серый или бежевый, 150×200' });
  await addGift(friends, 1001, '☕️', 'Капсульная кофемашина', 3490000, 'https://shopee.vn/may-pha-ca-phe-vien-nen', 'coffee', {
    note: 'Под капсулы Nespresso, чёрная',
    mustHave: true,
  });
  await addGift(friends, 1001, '🎧', 'Наушники AirPods Max', 13990000, 'https://www.apple.com/vn/airpods-max/', 'airpods');

  await addGift(friends, 1002, '🎮', 'Геймпад DualSense', 1790000, null, 'gamepad');
  await addGift(friends, 1002, '🧦', 'Носки с оленями', 150000);
  await addGift(friends, 1002, '🛹', 'Лонгборд', 2900000);

  await addGift(friends, 1003, '🪴', 'Монстера в большом горшке', 650000, null, 'monstera');
  await addGift(friends, 1003, '🎨', 'Набор акварели', 1200000);
  await addGift(friends, 1003, '🕯️', 'Свечи ручной работы', 390000);

  await addGift(friends, 1004, '📷', 'Камера Instax mini', 2590000, null, 'instax');
  await addGift(friends, 1004, '💄', 'Палетка теней', 890000);

  await pledge(friends, 1002, 1001, 1000000);
  await pledge(friends, 1004, 1001, 700000);
  await vote(friends, 1002, 1001, 'Тёплый плед с оленями');

  // Миша завёл группу в Telegram для участников сбора Алисе
  await callRpc(db, 'wl_set_pool_chat', {
    p_init_data: as(1002),
    p_room_id: friends.id,
    p_friend_id: 1001,
    p_link: 't.me/+AliceGift2027demo',
  });

  await pledge(friends, 1003, 1002, 500000);
  await pledge(friends, 1001, 1003, 400000);
  await pledge(friends, 1002, 1003, 600000);
  await vote(friends, 1001, 1003, 'Набор акварели');

  // --- Работа (RUB): Катя состоит в обеих компаниях ---
  const work = await createRoom(1004, 'Работа', 'RUB');
  for (const id of [1006, 1007]) await join(id, work);
  await addGift(work, 1006, '🎟️', 'Билеты в театр', 6000);
  await addGift(work, 1006, '📚', 'Книга про дизайн', 2500);
  await addGift(work, 1007, '🎸', 'Колонка JBL', 8990);
  await pledge(work, 1004, 1006, 2000);

  // Катя последней открывала «Друзей»; Макс (1005) придёт по приглашению в демо
  await callRpc(db, 'wl_bootstrap', { p_init_data: as(1004), p_room_id: friends.id });

  return { gifts, rooms: { friends, work } };
}
