import type { WebApp as WebAppType } from '@twa-dev/types';

// Читаем window.Telegram.WebApp напрямую: скрипт telegram-web-app.js в
// index.html сам подключается к настоящему клиенту Telegram (или к эмулятору
// из dev/), а вне Telegram оставляет заглушку с пустой initData.
export const tg: WebAppType | null = (() => {
  try {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      return window.Telegram.WebApp;
    }
  } catch {
    // не в среде Telegram
  }
  return null;
})();

/** Подписанные данные запуска. Пустые — значит, открыто не из Telegram. */
export const initData: string = tg?.initData ?? '';
export const isTelegram = initData.length > 0;
export const startParam: string | undefined = tg?.initDataUnsafe?.start_param;

function atLeast(version: string): boolean {
  try {
    return !!tg?.isVersionAtLeast(version);
  } catch {
    return false;
  }
}

export function initTelegramApp() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (atLeast('6.1')) {
      tg.setHeaderColor('secondary_bg_color');
      tg.setBackgroundColor('secondary_bg_color');
    }
    if (atLeast('7.7')) tg.disableVerticalSwipes();
    if (atLeast('7.10')) tg.setBottomBarColor('secondary_bg_color');
  } catch {
    // некоторые методы могут отсутствовать в старых клиентах
  }
}

export const supportsBackButton = () => atLeast('6.1');

export function haptic(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred?.(style);
  } catch {
    // нет вибрации — не страшно
  }
}

export function hapticNotification(type: 'error' | 'success' | 'warning') {
  try {
    tg?.HapticFeedback?.notificationOccurred?.(type);
  } catch {
    // нет вибрации — не страшно
  }
}

export function hapticSelection() {
  try {
    tg?.HapticFeedback?.selectionChanged?.();
  } catch {
    // нет вибрации — не страшно
  }
}

/** Диалог подтверждения через Telegram с откатом на window.confirm. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg && atLeast('6.2')) {
      try {
        tg.showConfirm(message, (confirmed) => resolve(!!confirmed));
        return;
      } catch {
        // откатываемся на window.confirm ниже
      }
    }
    resolve(window.confirm(message));
  });
}

export function openLink(url: string) {
  if (tg) {
    try {
      tg.openLink(url);
      return;
    } catch {
      // откатываемся на window.open
    }
  }
  window.open(url, '_blank', 'noopener');
}

export function openTelegramLink(url: string) {
  if (tg) {
    try {
      tg.openTelegramLink(url);
      return;
    } catch {
      // откатываемся на обычный переход
    }
  }
  window.open(url, '_blank', 'noopener');
}

/** Системный выбор или создание чата (Bot API 9.6+). false — не поддерживается или отменили. */
export function requestChat(buttonId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const webApp = tg as unknown as { requestChat?: (id: string, cb: (sent: boolean) => void) => void } | null;
    if (!webApp?.requestChat || !atLeast('9.6')) return resolve(false);
    try {
      webApp.requestChat(buttonId, (sent) => resolve(!!sent));
    } catch {
      resolve(false);
    }
  });
}

export const supportsRequestChat = () => atLeast('9.6');

/** Разрешил ли пользователь боту писать ему в личку (на момент запуска). */
export const allowsWriteToPm = (): boolean => !!tg?.initDataUnsafe?.user?.allows_write_to_pm;

export function requestWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tg || !atLeast('6.9')) return resolve(false);
    try {
      tg.requestWriteAccess((granted) => resolve(!!granted));
    } catch {
      resolve(false);
    }
  });
}

export function closeApp() {
  try {
    tg?.close();
  } catch {
    // вне Telegram закрывать нечего
  }
}
