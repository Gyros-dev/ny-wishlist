import { useEffect, useSyncExternalStore } from 'react';
import { api } from './client';

// Фото подарков приходят отдельно от списков: в списках только image_rev,
// а сами картинки догружаются пачкой и живут в памяти, пока открыт вишлист.
// Новая версия фото — новый ключ, старая просто перестаёт использоваться.

const cache = new Map<string, string>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let queue = new Map<string, number>();
let scheduled = false;

const keyOf = (id: string, rev: number) => `${id}:${rev}`;

function notify() {
  listeners.forEach((l) => l());
}

async function flush() {
  scheduled = false;
  const batch = queue;
  queue = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const res = await api.giftImages(chunk);
      for (const [id, img] of Object.entries(res)) cache.set(keyOf(id, img.rev), img.data);
    } catch {
      // попробуем снова при следующем показе
    } finally {
      chunk.forEach((id) => inflight.delete(keyOf(id, batch.get(id)!)));
    }
  }
  notify();
}

function request(id: string, rev: number) {
  const key = keyOf(id, rev);
  if (cache.has(key) || inflight.has(key)) return;
  inflight.add(key);
  queue.set(id, rev);
  if (!scheduled) {
    scheduled = true;
    window.setTimeout(() => void flush(), 0);
  }
}

/** Только что загруженное фото кладём в кэш сразу, без лишнего запроса. */
export function primeGiftImage(id: string, rev: number, data: string) {
  cache.set(keyOf(id, rev), data);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** data URL фото подарка или null, пока его нет или оно грузится. */
export function useGiftImage(id: string | undefined, rev: number | null | undefined): string | null {
  const key = id && rev ? keyOf(id, rev) : null;
  const data = useSyncExternalStore(subscribe, () => (key ? (cache.get(key) ?? null) : null));
  useEffect(() => {
    if (id && rev) request(id, rev);
  }, [id, rev]);
  return data;
}
