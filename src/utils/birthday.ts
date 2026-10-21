import { pluralize } from './format';

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export interface Birthday {
  month: number;
  day: number;
}

/** 'MM-DD' из API → { month, day }; null — дата не указана */
export function parseBirthday(value: string | null | undefined): Birthday | null {
  const m = /^(\d{2})-(\d{2})$/.exec(value ?? '');
  return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
}

/** Дней в месяце; по умолчанию високосный год — 29 февраля указать можно */
export function daysInMonth(month: number, year = 2024): number {
  return new Date(year, month, 0).getDate();
}

/** Дней до ближайшего дня рождения, 0 — сегодня. 29 февраля в невисокосный год — 28-го. */
export function daysUntilBirthday(b: Birthday, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (year: number) => new Date(year, b.month - 1, Math.min(b.day, daysInMonth(b.month, year)));
  let next = at(today.getFullYear());
  if (next < today) next = at(today.getFullYear() + 1);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

/** «15 марта» */
export function formatBirthday(b: Birthday): string {
  return `${b.day} ${MONTHS_GENITIVE[b.month - 1]}`;
}

/** «сегодня», «завтра», «через 5 дней» */
export function inDaysText(days: number): string {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${pluralize(days, ['день', 'дня', 'дней'])}`;
}
