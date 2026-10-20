export interface Currency {
  code: string;
  name: string;
  /** быстрые суммы взноса */
  chips: number[];
}

// Валюту выбирает создатель компании; суммы храним целыми в этой валюте
export const CURRENCIES: Currency[] = [
  { code: 'VND', name: 'Вьетнамский донг', chips: [200_000, 500_000, 1_000_000, 2_000_000] },
  { code: 'RUB', name: 'Российский рубль', chips: [1000, 2000, 3000, 5000] },
  { code: 'USD', name: 'Доллар США', chips: [10, 20, 50, 100] },
  { code: 'EUR', name: 'Евро', chips: [10, 20, 50, 100] },
  { code: 'THB', name: 'Тайский бат', chips: [300, 500, 1000, 2000] },
  { code: 'IDR', name: 'Индонезийская рупия', chips: [100_000, 200_000, 500_000, 1_000_000] },
  { code: 'KZT', name: 'Казахстанский тенге', chips: [5000, 10_000, 20_000, 50_000] },
  { code: 'GEL', name: 'Грузинский лари', chips: [20, 50, 100, 200] },
  { code: 'AMD', name: 'Армянский драм', chips: [5000, 10_000, 20_000, 50_000] },
  { code: 'TRY', name: 'Турецкая лира', chips: [200, 500, 1000, 2000] },
  { code: 'UAH', name: 'Украинская гривна', chips: [200, 500, 1000, 2000] },
  { code: 'GBP', name: 'Фунт стерлингов', chips: [10, 20, 50, 100] },
];

const DEFAULT_CHIPS = [1000, 2000, 5000, 10_000];

export function currencyInfo(code: string): Currency {
  return CURRENCIES.find((c) => c.code === code) ?? { code, name: code, chips: DEFAULT_CHIPS };
}

export function currencySymbolOf(code: string): string {
  try {
    const part = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
}

const BY_TIMEZONE: Record<string, string> = {
  'Asia/Ho_Chi_Minh': 'VND',
  'Asia/Saigon': 'VND',
  'Asia/Bangkok': 'THB',
  'Asia/Jakarta': 'IDR',
  'Asia/Makassar': 'IDR',
  'Asia/Jayapura': 'IDR',
  'Asia/Almaty': 'KZT',
  'Asia/Qostanay': 'KZT',
  'Asia/Aqtobe': 'KZT',
  'Asia/Tbilisi': 'GEL',
  'Asia/Yerevan': 'AMD',
  'Europe/Istanbul': 'TRY',
  'Europe/Kyiv': 'UAH',
  'Europe/Kiev': 'UAH',
  'Europe/London': 'GBP',
};

const RUSSIAN_TZ = /^(Europe\/(Moscow|Samara|Volgograd|Kirov|Ulyanovsk|Saratov|Astrakhan|Kaliningrad)|Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr))$/;

/** Валюта по умолчанию для новой компании — по часовому поясу телефона. */
export function guessCurrency(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    if (BY_TIMEZONE[tz]) return BY_TIMEZONE[tz];
    if (RUSSIAN_TZ.test(tz)) return 'RUB';
    if (tz.startsWith('Europe/')) return 'EUR';
    if (tz.startsWith('America/')) return 'USD';
  } catch {
    // нет Intl — берём рубль
  }
  return 'RUB';
}
