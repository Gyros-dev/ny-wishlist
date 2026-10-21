// Демо-магазин для автозаполнения подарка по ссылке. Локальный стенд отдаёт
// эти страницы сам, без интернета; остальные адреса функция скачивает как обычно.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGES = join(dirname(fileURLToPath(import.meta.url)), 'demo-images');

const PRODUCTS = {
  'shopee.vn/sony-wh-1000xm5': {
    title: 'Наушники Sony WH-1000XM5',
    price: 7990000,
    currency: 'VND',
    image: 'headphones.jpg',
  },
};

const HOSTS = new Set(Object.keys(PRODUCTS).map((key) => key.split('/')[0]));

const page = (p, url) => `<!doctype html><html><head>
<title>${p.title} | Демо-магазин</title>
<meta property="og:title" content="${p.title}">
<meta property="og:image" content="${new URL(`/__demo/${p.image}`, url)}">
<script type="application/ld+json">${JSON.stringify({
  '@type': 'Product',
  name: p.title,
  offers: { '@type': 'Offer', price: p.price, priceCurrency: p.currency },
})}</script>
</head><body></body></html>`;

export async function demoFetch(url, init) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const image = /^\/__demo\/([\w-]+\.jpg)$/.exec(u.pathname);
  if (image && HOSTS.has(host)) {
    return new Response(readFileSync(join(IMAGES, image[1])), { headers: { 'content-type': 'image/jpeg' } });
  }
  const product = PRODUCTS[`${host}${u.pathname.replace(/\/$/, '')}`];
  if (product) return new Response(page(product, url), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return fetch(url, { ...init, redirect: 'follow' });
}
