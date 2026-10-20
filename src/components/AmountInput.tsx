import { type InputHTMLAttributes, useEffect, useLayoutEffect, useRef } from 'react';
import { tg } from '../telegram/webapp';
import { formatNumber, parseAmount } from '../utils/format';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number;
  onChange: (value: number) => void;
};

/** Позиция в отформатированной строке сразу после digits-й цифры. */
function caretAfterDigits(text: string, digits: number): number {
  if (digits <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] >= '0' && text[i] <= '9' && ++seen === digits) return i + 1;
  }
  return text.length;
}

/**
 * Поле суммы с разделителями разрядов («7 990 000»). Пробелы вставляются при
 * каждом вводе, и без присмотра курсор прыгает в конец, а iOS ещё и рисует
 * его не на месте. Поэтому после переформатирования ставим курсор сразу
 * после той же по счёту цифры, а когда меняется размер вьюпорта (клавиатура,
 * MainButton) — переставляем его заново, чтобы WebKit перерисовал курсор.
 */
export function AmountInput({ value, onChange, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const pendingDigits = useRef<number | null>(null);
  const text = value ? formatNumber(value) : '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pendingDigits.current === null || document.activeElement !== el) return;
    const pos = caretAfterDigits(el.value, pendingDigits.current);
    pendingDigits.current = null;
    el.setSelectionRange(pos, pos);
  });

  useEffect(() => {
    const refresh = () => {
      const el = ref.current;
      if (!el || document.activeElement !== el) return;
      requestAnimationFrame(() => {
        const pos = el.selectionStart ?? el.value.length;
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // поле уже не в фокусе
        }
      });
    };
    tg?.onEvent?.('viewportChanged', refresh);
    window.visualViewport?.addEventListener('resize', refresh);
    return () => {
      tg?.offEvent?.('viewportChanged', refresh);
      window.visualViewport?.removeEventListener('resize', refresh);
    };
  }, []);

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={text}
      onChange={(e) => {
        const el = e.target;
        const caret = el.selectionStart ?? el.value.length;
        pendingDigits.current = el.value.slice(0, caret).replace(/\D/g, '').length;
        onChange(parseAmount(el.value));
      }}
    />
  );
}
