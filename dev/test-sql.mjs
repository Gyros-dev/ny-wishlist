// Проверка миграции на настоящем Postgres (PGlite): подпись initData, права,
// компании и их изоляция, приватность сборов, голосование и фото.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { DEMO_INVITE, PERSONAS, RpcError, callRpc, createDb, demoImage, seedDemo, signInitData } from './db.mjs';

let db;
let gifts;
let friends;
let work;
const as = (id) => signInitData(PERSONAS[id]);
const rpc = (fn, args) => callRpc(db, fn, args);

async function rejects(promise, { code, message }) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${err}`);
    if (code) assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

before(async () => {
  db = await createDb();
  ({ gifts, rooms: { friends, work } } = await seedDemo(db));
});

describe('Telegram initData', () => {
  test('корректная подпись принимается, профиль создаётся', async () => {
    const res = await rpc('wl_bootstrap', { p_init_data: as(1008), p_room_id: null });
    assert.equal(res.me.id, 1008);
    assert.equal(res.room, null, 'новичок без компаний');
    assert.deepEqual(res.rooms, []);
  });

  test('кириллица, пробелы и спецсимволы в имени не ломают подпись', async () => {
    const user = { id: 2001, first_name: 'Анна-Мария & Co', last_name: 'Д’Артаньян 100%+', username: 'anna' };
    const res = await rpc('wl_bootstrap', {
      p_init_data: signInitData(user, { extra: { start_param: `r${DEMO_INVITE}`, chat_type: 'private' } }),
      p_room_id: null,
    });
    assert.equal(res.me.first_name, 'Анна-Мария & Co');
    assert.equal(res.me.last_name, 'Д’Артаньян 100%+');
  });

  test('initData в кодировке encodeURIComponent (как у клиентов Telegram)', async () => {
    const signed = new URLSearchParams(signInitData({ id: 2002, first_name: "O'Neil (тест) *!~", username: 'oneil' }));
    const raw = [...signed.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    assert.ok(raw.includes('%20') && !raw.includes('+'));
    const res = await rpc('wl_bootstrap', { p_init_data: raw, p_room_id: null });
    assert.equal(res.me.first_name, "O'Neil (тест) *!~");
  });

  test('чужой токен, подмена пользователя, пустая и устаревшая initData отклоняются', async () => {
    const boot = (initData) => rpc('wl_bootstrap', { p_init_data: initData, p_room_id: null });
    await rejects(boot(signInitData(PERSONAS[1001], { token: '1:wrong' })), { code: '28000', message: /проверить/ });

    const forged = new URLSearchParams(as(1004));
    forged.set('user', JSON.stringify(PERSONAS[1001]));
    await rejects(boot(forged.toString()), { code: '28000' });

    const noHash = new URLSearchParams(as(1004));
    noHash.delete('hash');
    await rejects(boot(noHash.toString()), { code: '28000' });
    await rejects(boot(''), { code: '28000' });

    const old = signInitData(PERSONAS[1004], { authDate: Math.floor(Date.now() / 1000) - 3 * 86400 });
    await rejects(boot(old), { code: '28000', message: /устарела/ });
  });
});

describe('права доступа', () => {
  test('anon не видит таблицы и внутренние функции', async () => {
    for (const sql of ['select * from app.gifts', 'select * from app.pledges', 'select * from app.settings', 'select app.auth($1)']) {
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.exec('set local role anon');
          await tx.query(sql, sql.includes('$1') ? [as(1001)] : []);
        }),
        /permission denied/,
      );
    }
  });
});

describe('компании', () => {
  test('создание: название и валюта обязательны, создатель — участник и владелец', async () => {
    await rejects(rpc('wl_create_room', { p_init_data: as(1008), p_name: ' ', p_currency: 'VND' }), { message: /название/ });
    await rejects(rpc('wl_create_room', { p_init_data: as(1008), p_name: 'Семья', p_currency: 'донги' }), { message: /валюту/ });

    const room = await rpc('wl_create_room', { p_init_data: as(1008), p_name: '  Семья  ', p_currency: 'vnd' });
    assert.equal(room.name, 'Семья');
    assert.equal(room.currency, 'VND');
    assert.equal(room.is_owner, true);
    assert.equal(room.member_count, 1);
    assert.match(room.invite_code, /^[0-9a-f]{16}$/);

    const boot = await rpc('wl_bootstrap', { p_init_data: as(1008), p_room_id: null });
    assert.equal(boot.room.id, room.id, 'новая компания открывается сразу');
  });

  test('превью приглашения: название, валюта, участники — без кода и вишлистов', async () => {
    const res = await rpc('wl_room_preview', { p_init_data: as(1005), p_invite_code: DEMO_INVITE });
    assert.equal(res.name, 'Друзья · Новый год');
    assert.equal(res.currency, 'VND');
    assert.equal(res.member_count, 4);
    assert.equal(res.is_member, false);
    assert.equal(res.owner.first_name, 'Алиса');
    assert.equal(res.invite_code, undefined);
    assert.equal(res.members_preview.length, 4);
    await rejects(rpc('wl_room_preview', { p_init_data: as(1005), p_invite_code: 'nope000000' }), { message: /не найдено/ });
  });

  test('чужак не видит компанию и не может в ней ничего делать', async () => {
    const stranger = as(1008);
    // открыть чужую компанию нельзя — вернётся своя
    const boot = await rpc('wl_bootstrap', { p_init_data: stranger, p_room_id: friends.id });
    assert.notEqual(boot.room?.id, friends.id);
    assert.ok(!JSON.stringify(boot).includes('Алиса'));

    const forbidden = { code: 'WL403' };
    await rejects(rpc('wl_friend', { p_init_data: stranger, p_room_id: friends.id, p_friend_id: 1001 }), forbidden);
    await rejects(rpc('wl_set_pledge', { p_init_data: stranger, p_room_id: friends.id, p_friend_id: 1001, p_amount: 1 }), forbidden);
    await rejects(rpc('wl_vote', { p_init_data: stranger, p_room_id: friends.id, p_friend_id: 1001, p_gift_id: gifts['Тёплый плед с оленями'], p_on: true }), forbidden);
    await rejects(rpc('wl_set_pool_chat', { p_init_data: stranger, p_room_id: friends.id, p_friend_id: 1001, p_link: 't.me/+hack' }), forbidden);
    await rejects(rpc('wl_save_gift', { p_init_data: stranger, p_room_id: friends.id, p_gift_id: null, p_title: 'X', p_price: 1, p_emoji: null, p_link: null }), forbidden);
    const images = await rpc('wl_gift_images', { p_init_data: stranger, p_gift_ids: [gifts['Капсульная кофемашина']] });
    assert.deepEqual(images, {}, 'фото чужой компании не отдаются');
  });

  test('компании изолированы: в «Работе» не видно «Друзей» и наоборот', async () => {
    const atWork = await rpc('wl_bootstrap', { p_init_data: as(1006), p_room_id: null });
    assert.equal(atWork.room.currency, 'RUB');
    assert.deepEqual(atWork.members.map((m) => m.first_name).sort(), ['Катя', 'Пётр']);

    const katya = await rpc('wl_bootstrap', { p_init_data: as(1004), p_room_id: work.id });
    assert.deepEqual(katya.rooms.map((r) => r.name), ['Друзья · Новый год', 'Работа']);
    assert.ok(!katya.members.some((m) => m.first_name === 'Алиса'));
    // нельзя скинуться участнику другой компании
    await rejects(
      rpc('wl_set_pledge', { p_init_data: as(1004), p_room_id: work.id, p_friend_id: 1001, p_amount: 100 }),
      { message: /не найден/ },
    );
    // последняя открытая компания запоминается
    const again = await rpc('wl_bootstrap', { p_init_data: as(1004), p_room_id: null });
    assert.equal(again.room.id, work.id);
    await rpc('wl_bootstrap', { p_init_data: as(1004), p_room_id: friends.id });
  });

  test('вступление по приглашению, повторное — без дублей', async () => {
    const joined = await rpc('wl_join_room', { p_init_data: as(1005), p_invite_code: DEMO_INVITE });
    assert.equal(joined.id, friends.id);
    await rpc('wl_join_room', { p_init_data: as(1005), p_invite_code: DEMO_INVITE });
    const boot = await rpc('wl_bootstrap', { p_init_data: as(1005), p_room_id: null });
    assert.equal(boot.room.id, friends.id);
    assert.equal(boot.room.member_count, 5);
    assert.deepEqual(boot.gifts, []);
    assert.equal(boot.members.length, 4);
  });

  test('выход: подарки и взносы уходящего пропадают, владелец передаётся, пустая компания удаляется', async () => {
    const room = await rpc('wl_create_room', { p_init_data: as(1007), p_name: 'Временная', p_currency: 'USD' });
    await rpc('wl_join_room', { p_init_data: as(1006), p_invite_code: room.invite_code });
    const g = await rpc('wl_save_gift', { p_init_data: as(1007), p_room_id: room.id, p_gift_id: null, p_title: 'Кружка', p_price: 15, p_emoji: null, p_link: null });
    await rpc('wl_set_pledge', { p_init_data: as(1006), p_room_id: room.id, p_friend_id: 1007, p_amount: 10 });

    await rpc('wl_leave_room', { p_init_data: as(1007), p_room_id: room.id });
    const { rows } = await db.query(
      'select (select count(*)::int from app.gifts where id = $1) as gifts, (select count(*)::int from app.pledges where room_id = $2) as pledges, (select owner_id from app.rooms where id = $2) as owner',
      [g.id, room.id],
    );
    assert.deepEqual(rows[0], { gifts: 0, pledges: 0, owner: 1006 });

    await rpc('wl_leave_room', { p_init_data: as(1006), p_room_id: room.id });
    const left = await db.query('select count(*)::int as n from app.rooms where id = $1', [room.id]);
    assert.equal(left.rows[0].n, 0);
  });
});

describe('приватность', () => {
  test('не участник сбора не видит ни сумм, ни участников, ни чата', async () => {
    const res = await rpc('wl_friend', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1001 });
    assert.deepEqual(Object.keys(res).sort(), ['decided', 'friend', 'gifts', 'my_pledge', 'pool_chat', 'supporters']);
    assert.equal(res.supporters, null);
    assert.equal(res.pool_chat, null);
    const json = JSON.stringify(res);
    for (const leak of ['1000000', '700000', '1700000', 'Миша', 'Катя', 'AliceGift', 'voters']) {
      assert.ok(!json.includes(leak), `утечка: ${leak}`);
    }
    const plaid = res.gifts.find((g) => g.title === 'Тёплый плед с оленями');
    assert.equal(plaid.pct, 100);
    assert.equal(plaid.vote_pct, 50, 'за плед — 1 из 2 участников сбора');
    assert.equal(plaid.picked, true);
  });

  test('участники сбора видят друг друга и чат, но не суммы', async () => {
    const res = await rpc('wl_friend', { p_init_data: as(1004), p_room_id: friends.id, p_friend_id: 1001 });
    assert.deepEqual(res.supporters.map((s) => [s.first_name, s.username, s.is_me]), [
      ['Миша', 'misha_k', false],
      ['Катя', 'katya_iv', true],
    ]);
    assert.equal(res.pool_chat.link, 'https://t.me/+AliceGift2027demo');
    assert.equal(res.pool_chat.set_by.first_name, 'Миша');
    const json = JSON.stringify(res);
    assert.ok(!json.includes('1000000') && !json.includes('1700000'), 'чужих сумм нет');
    assert.ok(!json.includes('voters'), 'кто за что голосовал — не видно');
  });

  test('в списке участников — только проценты сбора', async () => {
    const res = await rpc('wl_bootstrap', { p_init_data: as(1003), p_room_id: friends.id });
    const alice = res.members.find((m) => m.id === 1001);
    assert.deepEqual(alice.progress, [100, 100, 48, 12]);
    assert.equal(alice.funded_count, 2);
    assert.deepEqual(alice.picked.map((p) => p.title), ['Тёплый плед с оленями']);
    const json = JSON.stringify(res.members);
    assert.ok(!json.includes('1700000') && !json.includes('supporters'));
  });

  test('владелец знает только, что ему скидываются', async () => {
    const res = await rpc('wl_bootstrap', { p_init_data: as(1001), p_room_id: friends.id });
    assert.equal(res.has_supporters, true);
    assert.ok(!JSON.stringify(res).includes('1000000'));
    await rejects(rpc('wl_friend', { p_init_data: as(1001), p_room_id: friends.id, p_friend_id: 1001 }), { message: /нельзя/ });
  });
});

describe('вишлист', () => {
  test('добавление, правка и удаление своего подарка', async () => {
    const g = await rpc('wl_save_gift', {
      p_init_data: as(1005), p_room_id: friends.id, p_gift_id: null, p_title: '  Наушники  ', p_price: 7990000, p_emoji: '🎧', p_link: 'shopee.vn/x',
    });
    assert.equal(g.title, 'Наушники');
    assert.equal(g.price, 7990000);
    assert.equal(g.link, 'https://shopee.vn/x');

    const upd = await rpc('wl_save_gift', {
      p_init_data: as(1005), p_room_id: friends.id, p_gift_id: g.id, p_title: 'Наушники Sony', p_price: 899000000000, p_emoji: '🎧', p_link: '',
    });
    assert.equal(upd.price, 899000000000, 'bigint: большие суммы в донгах');
    assert.equal(upd.link, null);

    await rejects(rpc('wl_save_gift', {
      p_init_data: as(1004), p_room_id: friends.id, p_gift_id: g.id, p_title: 'взлом', p_price: 1, p_emoji: null, p_link: null,
    }), { message: /не найден/ });
    assert.equal((await rpc('wl_delete_gift', { p_init_data: as(1004), p_gift_id: g.id })).deleted, false);
    assert.equal((await rpc('wl_delete_gift', { p_init_data: as(1005), p_gift_id: g.id })).deleted, true);
  });

  test('валидация названия и цены', async () => {
    const base = { p_init_data: as(1005), p_room_id: friends.id, p_gift_id: null, p_emoji: null, p_link: null };
    await rejects(rpc('wl_save_gift', { ...base, p_title: ' ', p_price: 100 }), { message: /Укажите/ });
    await rejects(rpc('wl_save_gift', { ...base, p_title: 'X', p_price: 0 }), { message: /цену/ });
  });

  test('в списке видны все участники компании, кроме меня; без вишлиста — в конце', async () => {
    await rpc('wl_join_room', { p_init_data: as(1006), p_invite_code: DEMO_INVITE });
    const res = await rpc('wl_bootstrap', { p_init_data: as(1004), p_room_id: friends.id });
    const names = res.members.map((m) => m.first_name);
    assert.equal(names[0], 'Алиса', 'сначала те, кому я скидываюсь');
    assert.deepEqual(names.slice(-2), ['Ирина', 'Макс'], 'без подарков — в конце');
    assert.ok(!names.includes('Катя'));
    assert.deepEqual(res.members.slice(-2).map((m) => m.gift_count), [0, 0]);
    await rpc('wl_leave_room', { p_init_data: as(1006), p_room_id: friends.id });
  });
});

describe('сбор и голосование', () => {
  test('взнос двигает проценты; others_pct — без моего вклада', async () => {
    const res = await rpc('wl_set_pledge', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001, p_amount: 1800000 });
    assert.equal(res.my_pledge, 1800000);
    const coffee = res.gifts.find((g) => g.title === 'Капсульная кофемашина');
    assert.equal(coffee.funded, true, '1 700 000 + 1 800 000 ≥ 3 490 000');
    assert.equal(coffee.pct, 100);
    assert.equal(coffee.others_pct, 48);
    const airpods = res.gifts.find((g) => g.title === 'Наушники AirPods Max');
    assert.equal(airpods.pct, 25);
    assert.deepEqual(res.gifts.map((g) => g.price), [350000, 890000, 3490000, 13990000], 'подарки по цене');
  });

  test('нельзя скинуться самому себе', async () => {
    await rejects(rpc('wl_set_pledge', { p_init_data: as(1001), p_room_id: friends.id, p_friend_id: 1001, p_amount: 100 }), { message: /самому себе/ });
  });

  test('голосовать можно только участнику сбора и только за подарок друга', async () => {
    await rejects(
      rpc('wl_vote', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1001, p_gift_id: gifts['Капсульная кофемашина'], p_on: true }),
      { message: /сначала укажите/ },
    );
    await rejects(
      rpc('wl_vote', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001, p_gift_id: gifts['Лонгборд'], p_on: true }),
      { message: /не найден/ },
    );
  });

  test('голоса за несколько подарков и итоговый набор в пределах бюджета', async () => {
    const vote = (id, title, on = true) =>
      rpc('wl_vote', { p_init_data: as(id), p_room_id: friends.id, p_friend_id: 1001, p_gift_id: gifts[title], p_on: on });
    const by = (res, title) => res.gifts.find((g) => g.title === title);
    const picked = (res) => res.gifts.filter((g) => g.picked).map((g) => g.title);

    // бюджет 3 500 000: Миша (плед), Катя и Макс — за кофемашину
    let res = await vote(1004, 'Капсульная кофемашина');
    assert.equal(by(res, 'Капсульная кофемашина').vote_pct, 33);
    assert.equal(res.decided, false, 'Макс ещё не голосовал');

    res = await vote(1005, 'Капсульная кофемашина');
    assert.equal(by(res, 'Капсульная кофемашина').vote_pct, 67);
    assert.equal(by(res, 'Капсульная кофемашина').my_vote, true);
    assert.equal(res.decided, true, 'все трое проголосовали');
    assert.deepEqual(picked(res), ['Капсульная кофемашина'], 'после кофемашины на плед уже не хватает');

    // Макс передумал: за плед и книгу — денег хватает сразу на два подарка
    await vote(1005, 'Капсульная кофемашина', false);
    await vote(1005, 'Тёплый плед с оленями');
    res = await vote(1005, 'Книга «Мастер и Маргарита», подарочное издание');
    assert.deepEqual(
      res.gifts.filter((g) => g.my_vote).map((g) => g.title).sort(),
      ['Книга «Мастер и Маргарита», подарочное издание', 'Тёплый плед с оленями'],
    );
    assert.deepEqual(picked(res), ['Книга «Мастер и Маргарита», подарочное издание', 'Тёплый плед с оленями']);
    assert.equal(res.decided, true);

    const list = await rpc('wl_bootstrap', { p_init_data: as(1003), p_room_id: friends.id });
    assert.equal(list.members.find((m) => m.id === 1001).picked.length, 2);

    // вернули как было: Макс за кофемашину
    await vote(1005, 'Тёплый плед с оленями', false);
    await vote(1005, 'Книга «Мастер и Маргарита», подарочное издание', false);
    res = await vote(1005, 'Капсульная кофемашина');
    assert.deepEqual(picked(res), ['Капсульная кофемашина']);
  });

  test('ссылка на чат сбора: только Telegram, задать и убрать может участник', async () => {
    const set = (id, link) => rpc('wl_set_pool_chat', { p_init_data: as(id), p_room_id: friends.id, p_friend_id: 1001, p_link: link });
    await rejects(set(1005, 'https://evil.example.com/+abc'), { message: /ссылка-приглашение/ });
    await rejects(set(1003, 't.me/+notsupporter'), { message: /только тем, кто скидывается/ });
    await rejects(set(1001, 't.me/+owner'), { message: /только тем, кто скидывается/ });
    let res = await set(1005, 'telegram.me/joinchat/AbCdEf123');
    assert.equal(res.pool_chat.link, 'https://t.me/joinchat/AbCdEf123');
    assert.equal(res.pool_chat.set_by.first_name, 'Макс');
    res = await set(1005, '');
    assert.equal(res.pool_chat, null);
    res = await set(1002, 'https://t.me/+AliceGift2027demo');
    assert.equal(res.pool_chat.link, 'https://t.me/+AliceGift2027demo');
  });

  test('выход из сбора убирает и голос', async () => {
    await rpc('wl_vote', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001, p_gift_id: gifts['Наушники AirPods Max'], p_on: true });
    const res = await rpc('wl_set_pledge', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001, p_amount: 0 });
    assert.equal(res.my_pledge, null);
    assert.ok(res.gifts.every((g) => !g.my_vote), 'все голоса Макса пропали');
    assert.equal(res.supporters, null, 'вышел из сбора — участников больше не видно');
    assert.equal(res.gifts.find((g) => g.title === 'Наушники AirPods Max').vote_pct, 0);
    assert.equal(res.gifts.find((g) => g.title === 'Капсульная кофемашина').funded, false);
  });

  test('удаление подарка убирает голоса за него', async () => {
    const g = await rpc('wl_save_gift', {
      p_init_data: as(1002), p_room_id: friends.id, p_gift_id: null, p_title: 'Временный', p_price: 100, p_emoji: '🎁', p_link: null,
    });
    await rpc('wl_vote', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002, p_gift_id: g.id, p_on: true });
    await rpc('wl_delete_gift', { p_init_data: as(1002), p_gift_id: g.id });
    const { rows } = await db.query('select count(*)::int as n from app.votes where gift_id = $1', [g.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('фото подарков', () => {
  test('списки отдают только версию фото, а не саму картинку', async () => {
    const res = await rpc('wl_friend', { p_init_data: as(1005), p_room_id: friends.id, p_friend_id: 1001 });
    assert.equal(typeof res.gifts.find((g) => g.title === 'Капсульная кофемашина').image_rev, 'number');
    assert.ok(!JSON.stringify(res).includes('data:image'));
  });

  test('участники компании получают фото по списку id', async () => {
    const ids = [gifts['Капсульная кофемашина'], gifts['Тёплый плед с оленями'], gifts['Носки с оленями']];
    const res = await rpc('wl_gift_images', { p_init_data: as(1004), p_gift_ids: ids });
    assert.ok(res[ids[0]].data.startsWith('data:image/jpeg;base64,'));
    assert.ok(res[ids[1]]);
    assert.equal(res[ids[2]], undefined, 'у носков нет фото');
  });

  test('замена и удаление своего фото, версия растёт', async () => {
    const g = await rpc('wl_save_gift', {
      p_init_data: as(1005), p_room_id: friends.id, p_gift_id: null, p_title: 'Фото-тест', p_price: 100, p_emoji: null, p_link: null,
    });
    assert.equal(g.image_rev, null);
    const a = await rpc('wl_set_gift_image', { p_init_data: as(1005), p_gift_id: g.id, p_image: demoImage('coffee') });
    const b = await rpc('wl_set_gift_image', { p_init_data: as(1005), p_gift_id: g.id, p_image: demoImage('plaid') });
    assert.ok(b.image_rev > a.image_rev);
    const img = await rpc('wl_gift_images', { p_init_data: as(1004), p_gift_ids: [g.id] });
    assert.equal(img[g.id].data, demoImage('plaid'));
    const c = await rpc('wl_set_gift_image', { p_init_data: as(1005), p_gift_id: g.id, p_image: '' });
    assert.equal(c.image_rev, null);
    assert.deepEqual(await rpc('wl_gift_images', { p_init_data: as(1004), p_gift_ids: [g.id] }), {});
    await rpc('wl_delete_gift', { p_init_data: as(1005), p_gift_id: g.id });
  });

  test('чужому подарку фото не поставить', async () => {
    await rejects(
      rpc('wl_set_gift_image', { p_init_data: as(1004), p_gift_id: gifts['Лонгборд'], p_image: demoImage('coffee') }),
      { message: /не найден/ },
    );
  });

  test('не картинка, SVG и слишком большой файл отклоняются', async () => {
    const id = gifts['Камера Instax mini'];
    const set = (img) => rpc('wl_set_gift_image', { p_init_data: as(1004), p_gift_id: id, p_image: img });
    await rejects(set('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), { message: /Поддерживаются/ });
    await rejects(set(`data:image/jpeg;base64,${Buffer.from('<html><script>alert(1)</script>').toString('base64')}`), { message: /не похож/ });
    await rejects(set(`data:image/jpeg;base64,/9j/${'A'.repeat(460000)}`), { message: /слишком большая/ });
  });

  test('фото удаляется вместе с подарком', async () => {
    const g = await rpc('wl_save_gift', {
      p_init_data: as(1003), p_room_id: friends.id, p_gift_id: null, p_title: 'Удаляемый', p_price: 100, p_emoji: null, p_link: null,
    });
    await rpc('wl_set_gift_image', { p_init_data: as(1003), p_gift_id: g.id, p_image: demoImage('book') });
    await rpc('wl_delete_gift', { p_init_data: as(1003), p_gift_id: g.id });
    const { rows } = await db.query('select count(*)::int as n from app.gift_images where gift_id = $1', [g.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('бронь «подарю сам»', () => {
  const reserve = (id, title, on = true) =>
    rpc('wl_reserve_gift', { p_init_data: as(id), p_room_id: friends.id, p_gift_id: gifts[title], p_reserve: on });
  const socksOf = (res) => res.gifts.find((g) => g.title === 'Носки с оленями');

  test('бронь сбрасывает голоса за подарок и видна забронировавшему', async () => {
    // Оля скидывается Мише и голосует за носки
    await rpc('wl_vote', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002, p_gift_id: gifts['Носки с оленями'], p_on: true });
    const res = await reserve(1004, 'Носки с оленями');
    const socks = socksOf(res);
    assert.equal(socks.reserved, true);
    assert.equal(socks.reserved_by_me, true);
    assert.equal(socks.vote_pct, null);
    const olya = await rpc('wl_friend', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002 });
    assert.equal(socksOf(olya).my_vote, false, 'голос Оли за носки сброшен');
  });

  test('остальные видят бронь, но не знают, чья она', async () => {
    const res = await rpc('wl_friend', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002 });
    const socks = socksOf(res);
    assert.equal(socks.reserved, true);
    assert.equal(socks.reserved_by_me, false);
    const json = JSON.stringify(res);
    assert.ok(!json.includes('1004') && !json.includes('Катя') && !json.includes('reserver'));
  });

  test('владелец не видит даже факта брони', async () => {
    const res = await rpc('wl_bootstrap', { p_init_data: as(1002), p_room_id: friends.id });
    assert.ok(!JSON.stringify(res.gifts).includes('reserv'));
    await rejects(
      rpc('wl_reserve_gift', { p_init_data: as(1002), p_room_id: friends.id, p_gift_id: gifts['Лонгборд'], p_reserve: true }),
      { message: /Свой подарок/ },
    );
  });

  test('второй желающий получает отказ, чужак — WL403', async () => {
    await rejects(reserve(1005, 'Носки с оленями'), { message: /уже кто-то дарит/ });
    await rejects(
      rpc('wl_reserve_gift', { p_init_data: as(1008), p_room_id: friends.id, p_gift_id: gifts['Носки с оленями'], p_reserve: true }),
      { code: 'WL403' },
    );
    // повторная бронь своим же — не ошибка
    assert.equal(socksOf(await reserve(1004, 'Носки с оленями')).reserved_by_me, true);
  });

  test('за забронированный подарок нельзя голосовать', async () => {
    await rejects(
      rpc('wl_vote', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002, p_gift_id: gifts['Носки с оленями'], p_on: true }),
      { message: /уже кто-то дарит сам/ },
    );
  });

  test('забронированные подарки не входят в прогресс сбора', async () => {
    const olya = await rpc('wl_bootstrap', { p_init_data: as(1003), p_room_id: friends.id });
    const misha = olya.members.find((m) => m.id === 1002);
    assert.equal(misha.gift_count, 3);
    assert.equal(misha.pool_count, 2);
    assert.equal(misha.reserved_count, 1);
    assert.equal(misha.my_reserved_count, 0);
    assert.equal(misha.progress.length, 2);
    const katya = await rpc('wl_bootstrap', { p_init_data: as(1004), p_room_id: friends.id });
    assert.equal(katya.members.find((m) => m.id === 1002).my_reserved_count, 1);
  });

  test('снять бронь может только тот, кто её поставил', async () => {
    await reserve(1003, 'Носки с оленями', false);
    let res = await rpc('wl_friend', { p_init_data: as(1003), p_room_id: friends.id, p_friend_id: 1002 });
    assert.equal(socksOf(res).reserved, true, 'чужая бронь осталась');
    res = await reserve(1004, 'Носки с оленями', false);
    assert.equal(socksOf(res).reserved, false);
  });

  test('бронь пропадает с подарком и с выходом из компании', async () => {
    const room = await rpc('wl_create_room', { p_init_data: as(1007), p_name: 'Бронь', p_currency: 'EUR' });
    await rpc('wl_join_room', { p_init_data: as(1006), p_invite_code: room.invite_code });
    const add = (title) => rpc('wl_save_gift', { p_init_data: as(1007), p_room_id: room.id, p_gift_id: null, p_title: title, p_price: 10, p_emoji: null, p_link: null });
    const a = await add('Шарф');
    const b = await add('Кружка');
    const res = (gift) => rpc('wl_reserve_gift', { p_init_data: as(1006), p_room_id: room.id, p_gift_id: gift.id, p_reserve: true });
    await res(a);
    await res(b);
    const count = async () => (await db.query('select count(*)::int as n from app.reservations where room_id = $1', [room.id])).rows[0].n;
    assert.equal(await count(), 2);
    await rpc('wl_delete_gift', { p_init_data: as(1007), p_gift_id: a.id });
    assert.equal(await count(), 1);
    await rpc('wl_leave_room', { p_init_data: as(1006), p_room_id: room.id });
    assert.equal(await count(), 0);
  });
});
