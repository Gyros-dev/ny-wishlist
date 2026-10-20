// Бот вишлиста (supabase/functions/telegram-bot) против настоящей схемы в
// PGlite и поддельного Bot API: создание чата сбора, приглашения, заявки.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { createBot, handleRequest } from '../supabase/functions/telegram-bot/index.ts';
import { DEMO_INVITE, PERSONAS, RpcError, callRpc, createDb, seedDemo, signInitData } from './db.mjs';
import { createFakeTelegram } from './fake-telegram.mjs';

let db;
let friends;
const SECRET = 'test-webhook-secret';
const as = (id) => signInitData(PERSONAS[id]);
const query = async (text, params) => (await db.query(text, params)).rows;

function setup(options) {
  const tg = createFakeTelegram(options);
  const bot = createBot({ query, telegram: tg.telegram });
  const post = (body, headers = {}) =>
    handleRequest(
      new Request('http://localhost/functions/v1/telegram-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      { bot, secret: SECRET },
    );
  const fromTelegram = (update) => post(update, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
  return { tg, bot, post, fromTelegram };
}

const prepare = (env, userId, friendId = 1001) =>
  env.post({ action: 'prepare_chat', init_data: as(userId), room_id: friends.id, friend_id: friendId });

before(async () => {
  db = await createDb();
  ({ rooms: { friends } } = await seedDemo(db));
  // Макс тоже скидывается Алисе: в сборе Миша, Катя и Макс
  await callRpc(db, 'wl_join_room', { p_init_data: as(1005), p_invite_code: DEMO_INVITE });
  await callRpc(db, 'wl_set_pledge', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001, p_amount: 1800000 });
  // сид уже прикрепил ручную ссылку — уберём, чтобы проверить создание с нуля
  await callRpc(db, 'wl_set_pool_chat', { p_init_data: as(1002), p_room_id: friends.id, p_friend_id: 1001, p_link: '' });
});

describe('«Создать чат сбора»', () => {
  test('мини-приложение получает кнопку для requestChat и запасной start_param', async () => {
    const env = setup();
    const res = await prepare(env, 1004);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.button_id, /^prepared_/);
    assert.match(body.start_param, /^c\d+$/);
    const call = env.tg.calls.find((c) => c.method === 'savePreparedKeyboardButton');
    assert.equal(call.body.user_id, 1004);
    assert.equal(call.body.button.request_chat.chat_is_channel, false);
    assert.equal(call.body.button.request_chat.bot_administrator_rights.can_invite_users, true);
  });

  test('не участник сбора, чужак и поддельная initData получают отказ', async () => {
    const env = setup();
    for (const [initData, re] of [
      [as(1003), /только те, кто скидывается/],
      [as(1008), /не состоите/],
      [signInitData(PERSONAS[1004], { token: '1:fake' }), /проверить/],
    ]) {
      const res = await env.post({ action: 'prepare_chat', init_data: initData, room_id: friends.id, friend_id: 1001 });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, re);
    }
    assert.equal(env.tg.calls.length, 0, 'до Telegram дело не дошло');
  });

  test('после выбора чата бот делает ссылку с заявками и зовёт участников в личку', async () => {
    const env = setup({ blockedPm: [1005] }); // Макс не разрешил боту писать
    const { button_id } = await (await prepare(env, 1004)).json();
    const chatId = -1009876543210;
    const res = await env.fromTelegram(env.tg.chatSharedUpdate(button_id, { chatId, title: 'Подарок Алисе' }));
    assert.equal(res.status, 200);

    const link = env.tg.calls.find((c) => c.method === 'createChatInviteLink');
    assert.equal(link.body.chat_id, chatId);
    assert.equal(link.body.creates_join_request, true);

    const messages = env.tg.calls.filter((c) => c.method === 'sendMessage');
    const to = (id) => messages.filter((m) => Number(m.body.chat_id) === id);
    assert.equal(to(chatId).length, 1, 'приветствие в чате');
    assert.match(to(chatId)[0].body.text, /Алис/);
    assert.equal(to(1002).length, 1, 'Мише — приглашение');
    assert.equal(to(1002)[0].body.reply_markup.inline_keyboard[0][0].text, 'Вступить в чат');
    assert.equal(to(1005).length, 1, 'Максу пытались написать');
    assert.match(to(1004)[0].body.text, /1 из 2/, 'Кате — отчёт: дошло одно приглашение из двух');

    // в приложении у участников сбора появилась ссылка, привязанная к боту
    const friend = await callRpc(db, 'wl_friend', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001 });
    assert.match(friend.pool_chat.link, /^https:\/\/t\.me\/\+demoPoolChat/);
    assert.equal(friend.pool_chat.managed, true);
    assert.equal(friend.pool_chat.set_by.first_name, 'Катя');
  });

  test('бот пускает в чат только участников сбора', async () => {
    const env = setup();
    const chatId = -1009876543210;
    for (const [userId, method] of [
      [1002, 'approveChatJoinRequest'],
      [1005, 'approveChatJoinRequest'],
      [1003, 'declineChatJoinRequest'],
      [1001, 'declineChatJoinRequest'],
      [4242, 'declineChatJoinRequest'],
    ]) {
      await env.fromTelegram({ update_id: 1, chat_join_request: { chat: { id: chatId }, from: { id: userId }, date: 0 } });
      const last = env.tg.calls.at(-1);
      assert.equal(last.method, method, `заявка ${userId}`);
      assert.equal(last.body.user_id, userId);
    }
  });

  test('кнопку нельзя использовать дважды и от чужого имени', async () => {
    const env = setup();
    const { button_id } = await (await prepare(env, 1002)).json();
    const update = env.tg.chatSharedUpdate(button_id, { chatId: -1001111 });
    update.message.from.id = 1003; // переслал кто-то другой
    await env.fromTelegram(update);
    assert.ok(!env.tg.calls.some((c) => c.method === 'createChatInviteLink'));
    assert.match(env.tg.calls.at(-1).body.text, /устарела/);

    update.message.from.id = 1002;
    await env.fromTelegram(update);
    assert.ok(env.tg.calls.some((c) => c.method === 'createChatInviteLink'), 'настоящий автор — сработало');
    const before = env.tg.calls.length;
    await env.fromTelegram(update);
    assert.equal(env.tg.calls.filter((c, i) => i >= before && c.method === 'createChatInviteLink').length, 0, 'повтор — нет');
  });

  test('запасной путь: /start c<id> в группе на старых клиентах', async () => {
    const env = setup();
    const { start_param } = await (await prepare(env, 1005)).json();
    const chatId = -1002222;
    await env.fromTelegram({
      update_id: 2,
      message: {
        message_id: 1,
        from: { id: 1005 },
        chat: { id: chatId, type: 'group', title: 'Алисе на НГ' },
        text: `/start@ny_wishlist_bot ${start_param}`,
      },
    });
    assert.equal(env.tg.calls.find((c) => c.method === 'createChatInviteLink').body.chat_id, chatId);
    const friend = await callRpc(db, 'wl_friend', { p_init_data: as(1004), p_room_id: friends.id, p_friend_id: 1001 });
    assert.equal(friend.pool_chat.set_by.first_name, 'Макс');
  });

  test('группа стала супергруппой — бот узнаёт её по новому id', async () => {
    const env = setup();
    await env.fromTelegram({ update_id: 3, message: { message_id: 2, chat: { id: -1002222, type: 'group' }, migrate_to_chat_id: -1003333 } });
    await env.fromTelegram({ update_id: 4, chat_join_request: { chat: { id: -1003333 }, from: { id: 1004 }, date: 0 } });
    assert.equal(env.tg.calls.at(-1).method, 'approveChatJoinRequest');
  });

  test('ручная ссылка отвязывает чат от бота', async () => {
    const res = await callRpc(db, 'wl_set_pool_chat', { p_init_data: as(1004), p_room_id: friends.id, p_friend_id: 1001, p_link: 't.me/+manualChat2027' });
    assert.equal(res.pool_chat.managed, false);
    const env = setup();
    await env.fromTelegram({ update_id: 5, chat_join_request: { chat: { id: -1003333 }, from: { id: 1004 }, date: 0 } });
    assert.equal(env.tg.calls.at(-1).method, 'declineChatJoinRequest', 'чат больше не привязан к сбору');
  });

  test('без секрета вебхука запрос от «Telegram» отклоняется', async () => {
    const env = setup();
    const res = await env.post({ update_id: 6, chat_join_request: { chat: { id: 1 }, from: { id: 1 } } });
    assert.equal(res.status, 403);
    assert.equal(env.tg.calls.length, 0);
    assert.ok(RpcError);
  });
});

describe('автозаполнение подарка по ссылке', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const shop = {
    'https://shop.example.vn/p/sony': `<!doctype html><html><head><title>Sony — магазин</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
        {"@type":"Product","name":"Наушники Sony WH-1000XM5","image":["https://cdn.example.vn/sony.png"],
         "offers":{"@type":"Offer","price":"7990000","priceCurrency":"VND"}}]}</script></head></html>`,
    'https://shop.example.ru/item': `<meta property="og:title" content="Плед &quot;Олени&quot;"><meta content="2 490,00" itemprop="price">`,
  };
  const fetchUrl = async (url) => {
    if (url === 'https://cdn.example.vn/sony.png') return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    if (shop[url]) return new Response(shop[url], { headers: { 'Content-Type': 'text/html' } });
    return new Response('nope', { status: 404 });
  };
  const preview = (initData, url) => {
    const bot = createBot({ query, telegram: createFakeTelegram().telegram, fetchUrl });
    return handleRequest(
      new Request('http://localhost/functions/v1/telegram-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview_link', init_data: initData, url }),
      }),
      { bot, secret: SECRET },
    );
  };

  test('JSON-LD: название, цена, валюта и фото', async () => {
    const res = await preview(as(1004), 'shop.example.vn/p/sony');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Наушники Sony WH-1000XM5');
    assert.equal(body.price, 7990000);
    assert.equal(body.currency, 'VND');
    assert.equal(body.image, `data:image/png;base64,${PNG.toString('base64')}`);
  });

  test('Open Graph и itemprop, без фото', async () => {
    const body = await (await preview(as(1004), 'https://shop.example.ru/item')).json();
    assert.equal(body.title, 'Плед "Олени"');
    assert.equal(body.price, 2490);
    assert.equal(body.image, null);
  });

  test('без подписи Telegram, на внутренние адреса и на недоступный магазин — отказ', async () => {
    let res = await preview('', 'https://shop.example.ru/item');
    assert.equal(res.status, 400);
    for (const url of ['http://localhost:54321/rest/v1', '192.168.0.1/admin', 'http://10.0.0.5', 'ftp://shop.example.ru']) {
      res = await preview(as(1004), url);
      assert.equal(res.status, 400, url);
    }
    res = await preview(as(1004), 'https://shop.example.ru/missing');
    assert.match((await res.json()).error, /не отдал страницу/);
  });
});
