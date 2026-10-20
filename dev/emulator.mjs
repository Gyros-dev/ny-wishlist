// npm run emulator — мини-приложение в эмуляторе Telegram с локальной базой.
import { startStack } from './stack.mjs';

const stack = await startStack({ log: true });

console.log(`
  🎄 Вишлист: локальный стенд запущен

  Эмулятор Telegram:  ${stack.emulatorUrl}
  Приглашение в чат:  ${stack.emulatorUrl}?phones=1005:light:chat,1004:dark
  Один телефон:       ${stack.emulatorUrl}?phones=1005:light
  Локальный API:      ${stack.apiUrl}  (PGlite, данные сбрасываются при перезапуске)

  Ctrl+C — остановить
`);

const stop = async () => {
  await stack.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
