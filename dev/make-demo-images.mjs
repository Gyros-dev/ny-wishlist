// Рисует демо-«фотографии» подарков (эмодзи на студийном фоне) для сида и видео.
// node dev/make-demo-images.mjs → dev/demo-images/*.jpg
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'demo-images');
mkdirSync(DIR, { recursive: true });

const IMAGES = {
  headphones: ['🎧', '#e9eef8', '#c9d5ee'],
  coffee: ['☕️', '#f6ece2', '#e2cdb8'],
  airpods: ['🎧', '#eef1f4', '#d3d9e0'],
  plaid: ['🧣', '#f8e9e9', '#e7c4c4'],
  book: ['📚', '#eef3e6', '#cfdcbc'],
  gamepad: ['🎮', '#ebe9f7', '#cbc6ee'],
  instax: ['📷', '#fbeef3', '#efc9d8'],
  monstera: ['🪴', '#e6f3ec', '#bfdcca'],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
for (const [name, [emoji, from, to]] of Object.entries(IMAGES)) {
  await page.setContent(`
    <body style="margin:0;width:800px;height:600px;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(120% 90% at 50% 30%, ${from} 0%, ${to} 100%);overflow:hidden">
      <div style="position:absolute;bottom:92px;width:380px;height:54px;border-radius:50%;
        background:radial-gradient(closest-side, rgba(0,0,0,.22), rgba(0,0,0,0))"></div>
      <div style="font-size:330px;line-height:1;transform:translateY(-18px);
        filter:drop-shadow(0 18px 18px rgba(0,0,0,.18))">${emoji}</div>
    </body>`);
  await page.screenshot({ path: join(DIR, `${name}.jpg`), type: 'jpeg', quality: 82 });
}
await browser.close();
console.log(`✓ ${Object.keys(IMAGES).length} images → ${DIR}`);
