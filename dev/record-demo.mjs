// npm run demo:record — записывает видео-демо demo/wishlist-demo.mp4.
//
// Поднимает локальный стенд, открывает эмулятор Telegram с двумя телефонами
// (Катя зовёт Макса в компанию «Друзья · Новый год», где уже собирают
// Алисе) и проигрывает сценарий через Playwright. Кадры снимаются CDP-скринкастом и собираются
// ffmpeg в H.264.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStack } from './stack.mjs';

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

// ---------- сценарий ----------
const coffee = '[data-gift="Капсульная кофемашина"]';
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

// 2. Свой вишлист
await step(1);
await say('Цены — в валюте компании, здесь это донги');
await tap(max.main, 800);
await tap(max.app('input[name="title"]'), 250);
await typeText('Наушники Sony');
await wait(250);
await tap(max.app('input[name="price"]'), 250);
await typeText('7990000', 110);
await wait(300);
await say('Можно приложить фото подарка и ссылку на товар');
await attachPhoto(max, join(ROOT, 'dev', 'demo-images', 'headphones.jpg'));
await wait(800);
await tap(max.app('input[name="link"]'), 250);
await typeText('shopee.vn/sony-wh-1000xm5', 40);
await wait(500);
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
await tap(max.app('[data-tab="friends"]'), 1400);
await say('Сумм не видно — только, на какие подарки уже хватает');
await wait(2000);
await tap(max.app('[data-friend="Алиса"]'), 1200);
await tap(katya.app('[data-friend="Алиса"]'), 1000);
await swipe(katya, 1004, 520);

// 4. Сумма и проценты
await step(3);
await say('Макс вписывает, сколько готов потратить…');
await swipe(max, 1005, 200);
await tap(max.app('#pledge'), 300);
await typeText('1800000', 260);
await wait(600);
await say('…и шкалы сразу показывают, хватит ли с его вкладом. Штриховка — его часть');
await wait(1000);
await swipe(max, 1005, 360);
await wait(1400);
await say('Кофемашина теперь по карману ✓ А сумму Макса не увидит никто');
await wait(1400);
await tap(max.main, 2200);

await say('У Кати шкалы обновились сами — в процентах, без сумм');
await katya.frame.locator(coffee).getByText('Хватает', { exact: true }).waitFor({ timeout: 10000 });
await wait(2400);

// 5. Голосование
await step(4);
await say('Голосование анонимное — видны только доли голосов');
await wait(800);
await tap(katya.app(`${coffee} [data-vote]`), 1600);
await max.app(`${coffee} [data-vote-pct="50"]`).waitFor({ timeout: 10000 });
await max.scrollTo(coffee, 150);
await say('У Макса голоса разделились 50 на 50 — он голосует за кофемашину');
await wait(1400);
await tap(max.app(`${coffee} [data-vote]`), 900);
await max.scrollTo('[data-decision]', 70);
await say('Все участники сбора проголосовали — кофемашина побеждает 🏆');
await wait(1500);
await katya.frame.locator('[data-decision]').waitFor({ timeout: 10000 });
await katya.scrollTo('[data-decision]', 70);
await emu(() => window.emu.hideFinger());
await wait(3000);

await step(5);
await say('');
await emu(() => window.emu.outro(true));
await wait(4500);

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
