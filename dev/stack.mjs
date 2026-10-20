// Локальный стенд: фейковый Supabase (PostgREST RPC поверх PGlite) + Vite.
import { createServer as createHttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createBot, handleRequest } from '../supabase/functions/telegram-bot/index.ts';
import { PERSONAS, RpcError, callRpc, createDb, seedDemo, signInitData } from './db.mjs';
import { createFakeTelegram } from './fake-telegram.mjs';

const BOT_SECRET = 'local-webhook-secret';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info, prefer',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const text = await readText(req);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startApi({ port = 54321, latencyMs = 120, seed = true, log = false } = {}) {
  let db = await createDb();
  if (seed) await seedDemo(db);
  // бот (Edge Function) против поддельного Telegram
  let fakeTelegram = createFakeTelegram();
  const bot = () => createBot({ query: async (text, params) => (await db.query(text, params)).rows, telegram: fakeTelegram.telegram });

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'OPTIONS') return send(res, 204);

    try {
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
      if (rpc && req.method === 'POST') {
        if (!req.headers.apikey) return send(res, 401, { message: 'No API key found in request', code: 'PGRST301' });
        const args = await readJson(req);
        await sleep(latencyMs);
        try {
          const result = await callRpc(db, rpc[1], args);
          if (log) console.log(`  rpc ${rpc[1]} ✓`);
          return send(res, 200, result);
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          if (log) console.log(`  rpc ${rpc[1]} ✗ ${err.code} ${err.message}`);
          return send(res, err.status, { code: err.code, message: err.message, details: null, hint: null });
        }
      }

      if (url.pathname === '/functions/v1/telegram-bot') {
        const body = req.method === 'POST' ? await readText(req) : undefined;
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
        await sleep(latencyMs);
        const response = await handleRequest(new Request(url, { method: req.method, headers, body }), { bot: bot(), secret: BOT_SECRET });
        // CORS функция ставит сама, как в Supabase
        res.writeHead(response.status, Object.fromEntries(response.headers));
        return res.end(await response.text());
      }

      // Служебные ручки эмулятора — в Supabase их нет
      if (url.pathname === '/__dev/request-chat' && req.method === 'POST') {
        // Так Telegram сообщает боту о чате, созданном по кнопке requestChat
        const { button_id, title } = await readJson(req);
        const update = fakeTelegram.chatSharedUpdate(button_id, { title });
        await bot().handleUpdate(update);
        return send(res, 200, { ok: true, chat_id: update.message.chat_shared.chat_id });
      }
      if (url.pathname === '/__dev/telegram-log') return send(res, 200, fakeTelegram.calls);
      if (url.pathname === '/__dev/personas') return send(res, 200, Object.values(PERSONAS));
      if (url.pathname === '/__dev/init-data') {
        const user = PERSONAS[url.searchParams.get('user')];
        if (!user) return send(res, 404, { message: 'unknown persona' });
        const start = url.searchParams.get('start');
        // start_param, как и у Telegram, входит в подписанные данные
        return send(res, 200, { user, initData: signInitData(user, { extra: start ? { start_param: start } : {} }) });
      }
      if (url.pathname === '/__dev/reset' && req.method === 'POST') {
        await db.close();
        db = await createDb();
        fakeTelegram = createFakeTelegram();
        if (url.searchParams.get('empty') !== '1') await seedDemo(db);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { message: 'Not found' });
    } catch (err) {
      console.error(err);
      return send(res, 500, { message: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    url: `http://localhost:${port}`,
    close: async () => {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

export async function startStack({ apiPort = 54321, webPort = 5173, latencyMs, log } = {}) {
  const api = await startApi({ port: apiPort, latencyMs, log });
  // Переменные окружения важнее .env.emulator — так стенд можно поднять на других портах
  process.env.VITE_SUPABASE_URL = api.url;
  const vite = await createViteServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.ts'),
    mode: 'emulator',
    logLevel: 'warn',
    server: { port: webPort, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();
  const webUrl = `http://127.0.0.1:${webPort}`;
  return {
    apiUrl: api.url,
    webUrl,
    emulatorUrl: `${webUrl}/dev/emulator.html`,
    close: async () => {
      await vite.close();
      await api.close();
    },
  };
}
