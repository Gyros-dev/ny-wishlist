import type { User } from '../api/types';
import { currencyInfo, currencySymbolOf } from './currencies';

const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

// Валюта открытой компании. Открыта всегда одна компания, поэтому проще
// держать её здесь, чем прокидывать во все компоненты.
let currencyCode = 'RUB';
let moneyFormat = makeMoneyFormat(currencyCode);

function makeMoneyFormat(code: string) {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  } catch {
    return null;
  }
}

export function setCurrency(code: string) {
  if (code === currencyCode) return;
  currencyCode = code;
  moneyFormat = makeMoneyFormat(code);
}

export function currencySymbol(): string {
  return currencySymbolOf(currencyCode);
}

export function quickAmounts(): number[] {
  return currencyInfo(currencyCode).chips;
}

export function formatNumber(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function formatMoney(value: number): string {
  const rounded = Math.round(value);
  const text = moneyFormat ? moneyFormat.format(rounded) : `${formatNumber(rounded)} ${currencyCode}`;
  // неразрывные пробелы, чтобы сумма не рвалась на две строки
  return text.replace(/[  ]/g, ' ');
}

/** 200 000 → «200 тыс.», 1 000 000 → «1 млн» — для кнопок быстрых сумм */
export function formatShort(value: number): string {
  return value >= 100_000 ? compactFormat.format(value) : formatNumber(value);
}

/** plural(3, ['подарок', 'подарка', 'подарков']) → 'подарка' */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function pluralize(n: number, forms: [string, string, string]): string {
  return `${formatNumber(n)} ${plural(n, forms)}`;
}

export function fullName(user: Pick<User, 'first_name' | 'last_name'>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

/** Только цифры, не больше 12 знаков: «7 990 000 ₫» → 7990000 */
export function parseAmount(input: string): number {
  const digits = input.replace(/\D/g, '').slice(0, 12);
  return digits ? Number(digits) : 0;
}

export function newYearCountdown(now = new Date()): { year: number; days: number; celebrating: boolean } {
  // Первая неделя января — ещё праздник, дальше считаем до следующего года
  if (now.getMonth() === 0 && now.getDate() <= 7) {
    return { year: now.getFullYear(), days: 0, celebrating: true };
  }
  const year = now.getFullYear() + 1;
  const target = new Date(year, 0, 1);
  const days = Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
  return { year, days, celebrating: false };
}

export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
