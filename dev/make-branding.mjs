// Картинки для бота:
//   bot-avatar.png      640×640 — аватар (@BotFather → /setuserpic)
//   bot-description.png 1280×720 — картинка в описании (/setdescriptionpic, 16:9)
// из branding/rat.svg — крыса с подарком в праздничном колпачке, на любой
// праздник. Те же картинки с суффиксом -new-year — из branding/rat-new-year.svg,
// с шапкой Санты и снегом: их можно ставить на декабрь.
// node dev/make-branding.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'branding');
const toUrl = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;

const CONFETTI = [
  [40, 46, '#ffd166', -24], [120, 300, '#ff8fab', 30], [250, 30, '#7be3c8', 18], [300, 318, '#8fd3ff', -30],
  [360, 120, '#ffd166', 40], [600, 40, '#ff8fab', -18], [610, 300, '#ffd166', 24], [14, 336, '#8fd3ff', -40],
];

const VARIANTS = [
  {
    svg: 'rat.svg',
    suffix: '',
    label: 'Новый год · дни рождения',
    // конфетти на фоне баннера
    decor: CONFETTI.map(
      ([x, y, color, deg]) =>
        `<div style="position:absolute;left:${x}px;top:${y}px;width:13px;height:6px;border-radius:2px;background:${color};transform:rotate(${deg}deg)"></div>`,
    ).join(''),
  },
  {
    svg: 'rat-new-year.svg',
    suffix: '-new-year',
    label: 'Новый год',
    // сугроб внизу баннера
    decor: `<svg style="position:absolute;left:0;bottom:0" width="640" height="60" viewBox="0 0 640 60" preserveAspectRatio="none">
      <path d="M0 30 Q 160 6 320 22 Q 480 38 640 14 L640 60 L0 60 Z" fill="#e9eefc"/>
    </svg>`,
  },
];

const browser = await chromium.launch();

for (const v of VARIANTS) {
  const svg = readFileSync(join(DIR, v.svg), 'utf8');
  // для баннера — крыса без собственного фона, на фоне баннера
  const ratOnly = svg.replace(/<!-- backdrop:start -->[\s\S]*<!-- backdrop:end -->/, '');

  const avatar = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
  await avatar.setContent(`<body style="margin:0"><img src="${toUrl(svg)}" width="640" height="640" style="display:block"></body>`);
  await avatar.screenshot({ path: join(DIR, `bot-avatar${v.suffix}.png`) });

  const banner = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });
  await banner.setContent(`
    <body style="margin:0;width:640px;height:360px;overflow:hidden;position:relative;font-family:-apple-system,'SF Pro Display',Inter,sans-serif;
      background:radial-gradient(120% 140% at 85% 30%, #6048d2 0%, #2c2f88 50%, #131536 100%);color:#fff">
      <div style="position:absolute;right:20px;top:40px;width:330px;height:330px;border-radius:50%;
        background:radial-gradient(closest-side, rgba(255,207,110,.4), rgba(255,207,110,0))"></div>
      ${v.decor}
      <img src="${toUrl(ratOnly)}" style="position:absolute;right:-6px;top:${v.suffix ? -8 : 8}px;width:380px;height:380px">
      <div style="position:absolute;left:36px;top:70px;width:300px">
        <div style="font-size:14px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.7)">${v.label}</div>
        <div style="margin-top:10px;font-size:48px;line-height:1;font-weight:800;letter-spacing:-.02em">Вишлист</div>
        <div style="margin-top:16px;font-size:19px;line-height:1.35;color:rgba(255,255,255,.85)">
          Загадайте подарки —<br>а&nbsp;друзьям дарите вместе, в&nbsp;складчину
        </div>
      </div>
    </body>`);
  await banner.screenshot({ path: join(DIR, `bot-description${v.suffix}.png`) });
}

await browser.close();
console.log(`✓ ${DIR}: bot-avatar(.png|-new-year.png), bot-description(.png|-new-year.png)`);
