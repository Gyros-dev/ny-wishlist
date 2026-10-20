// Картинки для бота из branding/rat.svg:
//   bot-avatar.png      640×640 — аватар (@BotFather → /setuserpic)
//   bot-description.png 1280×720 — картинка в описании (/setdescriptionpic, 16:9)
// node dev/make-branding.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'branding');
const svg = readFileSync(join(DIR, 'rat.svg'), 'utf8');
const toUrl = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
const ratUrl = toUrl(svg);
// Для баннера — крыса без собственного фона, на фоне баннера
const ratOnlyUrl = toUrl(svg.replace(/<!-- backdrop:start -->[\s\S]*<!-- backdrop:end -->/, ''));

const browser = await chromium.launch();

const avatar = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
await avatar.setContent(`<body style="margin:0"><img src="${ratUrl}" width="640" height="640" style="display:block"></body>`);
await avatar.screenshot({ path: join(DIR, 'bot-avatar.png') });

const banner = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });
await banner.setContent(`
  <body style="margin:0;width:640px;height:360px;overflow:hidden;position:relative;font-family:-apple-system,'SF Pro Display',Inter,sans-serif;
    background:radial-gradient(120% 140% at 85% 30%, #6048d2 0%, #2c2f88 50%, #131536 100%);color:#fff">
    <div style="position:absolute;right:20px;top:40px;width:330px;height:330px;border-radius:50%;
      background:radial-gradient(closest-side, rgba(255,207,110,.4), rgba(255,207,110,0))"></div>
    <svg style="position:absolute;left:0;bottom:0" width="640" height="60" viewBox="0 0 640 60" preserveAspectRatio="none">
      <path d="M0 30 Q 160 6 320 22 Q 480 38 640 14 L640 60 L0 60 Z" fill="#e9eefc"/>
    </svg>
    <img src="${ratOnlyUrl}" style="position:absolute;right:-6px;top:-8px;width:380px;height:380px">
    <div style="position:absolute;left:36px;top:70px;width:290px">
      <div style="font-size:15px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.7)">Новый год 2027</div>
      <div style="margin-top:10px;font-size:48px;line-height:1;font-weight:800;letter-spacing:-.02em">Вишлист</div>
      <div style="margin-top:16px;font-size:19px;line-height:1.35;color:rgba(255,255,255,.85)">
        Загадайте подарки —<br>а&nbsp;друзьям дарите вместе, в&nbsp;складчину
      </div>
    </div>
  </body>`);
await banner.screenshot({ path: join(DIR, 'bot-description.png') });

await browser.close();
console.log(`✓ ${DIR}/bot-avatar.png, bot-description.png`);
