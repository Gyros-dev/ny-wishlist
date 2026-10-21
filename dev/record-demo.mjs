// npm run demo:record — записывает видео-демо demo/wishlist-demo.mp4.
//
// Поднимает локальный стенд, открывает эмулятор Telegram с двумя телефонами
// (Катя зовёт Макса в компанию «Друзья · Новый год», где уже собирают
// Алисе: подарок по ссылке, «хватает сразу на N», голосование за несколько
// подарков, покупка и Тайный Санта) и проигрывает сценарий через Playwright. Кадры снимаются CDP-скринкастом и собираются
// ffmpeg в H.264.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStack } from './stack.mjs';
import { PERSONAS, signInitData } from './db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo', 'wishlist-demo.mp4');
const FRAMES = join(ROOT, 'demo', '.frames');
const W = 1920;
const H = 1080;

const stack = await startStack({ apiPort: 54331, webPort: 5183, latencyMs: 90 });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ru-RU' });
const page = await context.newPage();
page.on('pageerror', (err) => console.error('pageerror:', err.message));

await page.goto(`${stack.emulatorUrl}?demo=1&phones=1005:light:chat,1004:dark&api=${encodeURIComponent(stack.apiUrl)}`);
await page.evaluate(async () => {
  await window.emu.started;
  await window.emu.ready;
});
await page.waitForTimeout(800);

// ---------- запись кадров ----------
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(FRAMES, `${String(frames.length).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, ts: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

// ---------- помощники ----------
const wait = (ms) => page.waitForTimeout(ms);
const emu = (fn, arg) => page.evaluate(fn, arg);
const step = (i) => emu((i) => window.emu.step(i), i);
const say = (text) => emu((t) => window.emu.say(t), text);

const phone = (id) => {
  const frame = page.frameLocator(`#phone-${id} iframe`);
  return {
    frame,
    app: (selector) => frame.locator(selector).first(),
    text: (text) => frame.getByText(text, { exact: false }).first(),
    main: page.locator(`#phone-${id} .main-button`),
    async scrollBy(dy, screen = 'friend') {
      const f = page.frame({ url: new RegExp(`u=${id}&`) });
      await f.evaluate(
        ([dy, screen]) => document.querySelector(`[data-screen="${screen}"]`)?.scrollBy({ top: dy, behavior: 'smooth' }),
        [dy, screen],
      );
    },
    async scrollTo(selector, offset = 12, screen = 'friend') {
      const f = page.frame({ url: new RegExp(`u=${id}&`) });
      await f.evaluate(
        ([selector, offset, screen]) => {
          const box = document.querySelector(`[data-screen="${screen}"]`);
          const target = document.querySelector(selector);
          if (!box || !target) return;
          const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - offset;
          box.scrollTo({ top, behavior: 'smooth' });
        },
        [selector, offset, screen],
      );
    },
  };
};

async function center(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Если элемент за краем экрана телефона — плавно докручиваем к нему. */
async function ensureVisible(locator) {
  const moved = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top >= 60 && r.bottom <= window.innerHeight - 16) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  });
  if (moved) await wait(750);
}

/** «Палец» доезжает до элемента, нажимает и кликает по-настоящему. */
async function tap(locator, after = 450) {
  await locator.waitFor({ state: 'visible' });
  await ensureVisible(locator);
  const { x, y } = await center(locator);
  await emu(([x, y]) => window.emu.move(x, y), [x, y]);
  await wait(560);
  await emu(() => window.emu.press(true));
  await wait(90);
  await page.mouse.click(x, y);
  await emu(() => window.emu.press(false));
  await wait(after);
}

/** Тап по кнопке, открывающей выбор файла, и подстановка картинки. */
async function attachPhoto(p, file) {
  const chooser = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
  await tap(p.app('[data-add-photo]'), 0);
  const fc = await chooser;
  if (fc) await fc.setFiles(file);
  else await p.app('[data-photo-input]').setInputFiles(file);
  await p.app('[data-photo-preview]').waitFor({ timeout: 8000 });
}

async function typeText(text, delay = 95) {
  await page.keyboard.type(text, { delay });
}

/** Свайп пальцем по телефону с плавной прокруткой содержимого. */
async function swipe(p, id, dy, screen = 'friend') {
  const device = page.locator(`#phone-${id} .viewport`);
  const box = await device.boundingBox();
  const x = box.x + box.width * 0.62;
  const y0 = box.y + box.height * 0.72;
  await emu(([x, y]) => window.emu.move(x, y), [x, y0]);
  await wait(520);
  await emu(() => window.emu.press(true));
  await emu(([x, y]) => window.emu.move(x, y), [x, y0 - Math.min(260, Math.abs(dy) * 0.7) * Math.sign(dy)]);
  await p.scrollBy(dy, screen);
  await wait(520);
  await emu(() => window.emu.press(false));
  await wait(350);
}

const max = phone(1005);
const katya = phone(1004);

/** RPC от имени демо-персонажа — действия тех, кого нет на экране. */
async function rpc(user, fn, args) {
  const res = await fetch(`${stack.apiUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'demo' },
    body: JSON.stringify({ p_init_data: signInitData(PERSONAS[user]), ...args }),
  });
  if (!res.ok) throw new Error(`${fn}: ${await res.text()}`);
  return res.json();
}
const friendsRoomId = (await rpc(1004, 'wl_bootstrap', { p_room_id: null })).room.id;

// ---------- сценарий ----------
const coffee = '[data-gift="Капсульная кофемашина"]';
const book = '[data-gift^="Книга"]';
await wait(1600);

// 1. Компания и приглашение
await step(0);
await say('У Кати две компании: «Друзья» в донгах и «Работа» в рублях');
await wait(800);
await tap(katya.app('[data-room-switch]'), 1800);
await say('Вишлисты компаний не пересекаются. Катя зовёт Макса в «Друзей»');
await wait(900);
await tap(katya.app('[data-invite]'), 1000);
await say('Макс получает ссылку-приглашение прямо в чате Telegram');
await wait(1400);
await tap(page.locator('#phone-1004 .tg-left'), 300);
await tap(page.locator('#phone-1005 [data-open-invite]').last(), 300);
await max.app('[data-screen="join"]').waitFor({ timeout: 10000 });
await say('Видно, куда зовут, — и вступить можно в один тап');
await wait(2000);
await tap(max.main, 300);
await max.app('[data-screen="home"]').waitFor({ timeout: 10000 });
await wait(1200);

// 2. Свой вишлист: подарок по ссылке
await step(1);
await say('Достаточно вставить ссылку на товар…');
await tap(max.main, 800);
await tap(max.app('input[name="link"]'), 250);
await typeText('shopee.vn/sony-wh-1000xm5', 45);
await max.app('[data-photo-preview]').waitFor({ timeout: 10000 });
await say('…название, цена в донгах и фото подтянулись сами');
await wait(2600);
await say('Можно добавить комментарий и отметить самое желанное');
await tap(max.app('textarea[name="note"]'), 250);
await typeText('Чёрные или серебристые', 70);
await wait(300);
await tap(max.app('[data-must-have]'), 900);
await tap(max.main, 1400);

await tap(max.main, 700);
await tap(max.app('input[name="title"]'), 200);
await typeText('Скейтборд', 70);
await tap(max.app('input[name="price"]'), 200);
await typeText('1500000', 90);
await wait(300);
await tap(max.main, 1400);

// 3. Выбор друга
await step(2);
await say('Во вкладке «Участники» — чьи вишлисты уже готовы');
await tap(max.app('[data-tab="friends"]'), 1200);
await say('На карточке видно, на сколько подарков уже хватает и сколько не хватает ещё на один');
await wait(2800);
await tap(max.app('[data-friend="Алиса"]'), 1200);
await tap(katya.app('[data-friend="Алиса"]'), 1000);
await say('Миша и Катя уже скинулись Алисе: хватает сразу на книгу и плед, но не на кофемашину');
await wait(3200);

// 4. Сумма
await step(3);
await say('Макс может вписать любую сумму — или одним тапом ровно столько, сколько не хватает');
await wait(600);
await tap(max.app('[data-top-up]'), 900);
await max.scrollTo('[data-summary]', 12);
await say('С его вкладом хватит сразу на три подарка');
await wait(2400);
await max.scrollTo(coffee, 150);
await say('Шкалы показывают это заранее, штриховка — его часть. Сумму Макса не увидит никто');
await wait(2800);
await tap(max.main, 1800);
await say('У Кати всё обновилось само');
await katya.app('[data-together="3"]').waitFor({ timeout: 10000 });
await wait(2400);

// 5. Голосование за несколько подарков
await step(4);
await say('Миша голосовал за плед. Катя добавляет голос за кофемашину');
await wait(600);
await tap(katya.app(`${coffee} [data-vote]`), 900);
await katya.app('[data-picked-preview]').waitFor({ timeout: 10000 });
await katya.scrollTo('[data-picked-preview]', 70);
await say('Денег хватает на оба — и ещё остаётся на книгу');
await wait(3000);
await max.app(`${book} [data-fits-extra]`).waitFor({ timeout: 10000 });
await max.scrollTo(book, 120);
await say('Макс голосует за книгу…');
await wait(1000);
await tap(max.app(`${book} [data-vote]`), 900);
await max.app('[data-decision]').waitFor({ timeout: 10000 });
await max.scrollTo('[data-decision]', 70);
await say('…и в покупку попадают все три подарка 🏆');
await wait(3000);

// 6. Кто покупает
await step(5);
await say('Участники сбора видят друг друга — можно завести общий чат и договориться');
await katya.scrollTo('[data-pool-team]', 70);
await wait(2600);
await say('Катя берёт покупку на себя');
await tap(katya.app('[data-purchase-take]'), 1200);
await max.app('[data-purchase="buying"]').waitFor({ timeout: 10000 });
await max.scrollTo('[data-purchase]', 120);
await say('Макс видит, кому переводить свою часть');
await wait(2800);
await say('Подарки куплены — Катя отмечает, и сбор закрывается');
await tap(katya.app('[data-purchase-bought]'), 700);
await tap(page.locator('#phone-1004 .popup-layer button:not(.cancel)').first(), 400);
await katya.app('[data-closed]').waitFor({ timeout: 10000 });
await katya.scrollTo('[data-summary]', 70);
await max.app('[data-closed]').waitFor({ timeout: 10000 });
await max.scrollTo('[data-summary]', 70);
await wait(2600);

// 7. Тайный Санта: Алиса открыла набор, Миша и Оля уже записались
await rpc(1001, 'wl_santa', { p_room_id: friendsRoomId, p_action: 'open', p_budget: 500000 });
for (const id of [1002, 1003]) await rpc(id, 'wl_santa', { p_room_id: friendsRoomId, p_action: 'join', p_budget: null });
await step(6);
await say('А ещё в компании можно провести Тайного Санту');
await tap(page.locator('#phone-1004 .tg-left'), 200);
await tap(page.locator('#phone-1005 .tg-left'), 600);
await tap(katya.app('[data-santa-join]'), 500);
await tap(max.app('[data-santa-join]'), 900);
await say('Алиса проводит жеребьёвку — бот пишет каждому, кому он дарит. Пару знает только сам Санта');
await wait(800);
await rpc(1001, 'wl_santa', { p_room_id: friendsRoomId, p_action: 'draw', p_budget: null });
await Promise.all([katya, max].map((p) => p.app('[data-santa-receiver]').waitFor({ timeout: 15000 })));
await emu(() => window.emu.hideFinger());
await wait(3600);

await step(7);
await say('');
await emu(() => window.emu.outro(true));
await wait(5000);

// ---------- сборка видео ----------
await cdp.send('Page.stopScreencast');
await wait(300);
await browser.close();
await stack.close();

if (frames.length < 10) throw new Error(`too few frames: ${frames.length}`);
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]?.ts ?? frames[i].ts + 0.5;
  lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].ts).toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
const list = join(FRAMES, 'list.txt');
writeFileSync(list, lines.join('\n'));

const seconds = frames[frames.length - 1].ts - frames[0].ts;
console.log(`frames: ${frames.length}, duration: ${seconds.toFixed(1)}s`);

const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-movflags', '+faststart', OUT],
  { stdio: 'inherit' },
);
if (ff.status !== 0) throw new Error('ffmpeg failed');
rmSync(FRAMES, { recursive: true, force: true });
console.log(`✓ ${OUT}`);
