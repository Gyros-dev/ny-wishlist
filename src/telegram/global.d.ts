import type { WebApp as WebAppTypes } from '@twa-dev/types';

declare global {
  interface Window {
    Telegram?: {
      WebApp: WebAppTypes;
    };
  }
}

export {};
