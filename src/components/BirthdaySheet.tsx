import { useIsPresent } from 'framer-motion';
import { useState } from 'react';
import { Layer, useMainButton } from '../telegram/buttons';
import { hapticSelection } from '../telegram/webapp';
import { type Birthday, MONTH_NAMES, daysInMonth, parseBirthday } from '../utils/birthday';
import { Sheet } from './Sheet';

/** Свой день рождения: день и месяц, без года. Одна дата на все компании. */
export function BirthdaySheet({
  open,
  value,
  onClose,
  onSave,
}: {
  open: boolean;
  value: string | null;
  onClose: () => void;
  onSave: (birthday: Birthday | null) => Promise<void>;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Ваш день рождения">
      <BirthdayForm value={value} onSave={onSave} />
    </Sheet>
  );
}

function BirthdayForm({ value, onSave }: { value: string | null; onSave: (birthday: Birthday | null) => Promise<void> }) {
  const isPresent = useIsPresent();
  const initial = parseBirthday(value);
  const [day, setDay] = useState(initial?.day ?? 0);
  const [month, setMonth] = useState(initial?.month ?? 0);
  const [saving, setSaving] = useState(false);
  const max = month ? daysInMonth(month) : 31;
  const valid = day > 0 && month > 0 && day <= max;

  const save = async (birthday: Birthday | null) => {
    setSaving(true);
    try {
      await onSave(birthday);
    } finally {
      setSaving(false);
    }
  };

  useMainButton(
    Layer.sheet,
    valid ? { text: 'Сохранить', onClick: () => void save({ month, day }), loading: saving } : null,
    isPresent,
  );

  const selectClass =
    'block h-12 w-full appearance-none rounded-[12px] bg-fill px-3 text-[17px] font-semibold outline-none';

  return (
    <div className="space-y-4 pb-2" data-birthday-form>
      <div className="flex flex-col items-center pt-1 text-center">
        <div className="bob text-[56px]">🎂</div>
        <p className="mt-2 px-4 text-[14px] leading-snug text-hint">
          Друзья увидят дату и успеют скинуться на подарок, а бот напомнит им заранее
        </p>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2 rounded-[16px] bg-card p-3">
        <label className="block">
          <span className="mb-1 block px-1 text-[12px] font-medium text-hint">День</span>
          <select
            name="birthday-day"
            value={day}
            onChange={(e) => {
              hapticSelection();
              setDay(Number(e.target.value));
            }}
            className={selectClass}
          >
            <option value={0} disabled>
              —
            </option>
            {Array.from({ length: max }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block px-1 text-[12px] font-medium text-hint">Месяц</span>
          <select
            name="birthday-month"
            value={month}
            onChange={(e) => {
              hapticSelection();
              const next = Number(e.target.value);
              setMonth(next);
              setDay((d) => Math.min(d, daysInMonth(next)));
            }}
            className={selectClass}
          >
            <option value={0} disabled>
              Выберите
            </option>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="px-2 text-center text-[13px] leading-snug text-hint">
        Год не нужен. Дата одна для всех ваших компаний
      </p>
      {initial && (
        <button
          type="button"
          onClick={() => void save(null)}
          disabled={saving}
          className="w-full py-2 text-center text-[15px] text-destructive"
        >
          Убрать дату
        </button>
      )}
    </div>
  );
}
