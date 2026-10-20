import { openTelegramLink } from '../telegram/webapp';

const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME ?? '').replace(/^@/, '');
const APP_SHORT_NAME = import.meta.env.VITE_APP_SHORT_NAME ?? '';

export const canShare = BOT_USERNAME !== '';

/** Ссылка на мини-приложение; startapp=r<код> — приглашение в компанию. */
export function appLink(startParam?: string): string | null {
  if (!BOT_USERNAME) return null;
  const base = APP_SHORT_NAME
    ? `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}`
    : `https://t.me/${BOT_USERNAME}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}

/** Добавить бота в группу админом — запасной путь для «Создать чат сбора» */
export function startGroupLink(startParam: string): string | null {
  if (!BOT_USERNAME) return null;
  return `https://t.me/${BOT_USERNAME}?startgroup=${encodeURIComponent(startParam)}&admin=invite_users`;
}

export function inviteLink(inviteCode: string): string | null {
  return appLink(`r${inviteCode}`);
}

export function shareToTelegram(link: string, text: string) {
  openTelegramLink(
    `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
  );
}

/** «rnyfriends2027» → «nyfriends2027» */
export function inviteCodeFromStartParam(param: string | undefined): string | null {
  const m = /^r([A-Za-z0-9_-]{6,32})$/.exec(param ?? '');
  return m ? m[1] : null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
