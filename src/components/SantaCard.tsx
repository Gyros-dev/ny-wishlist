import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { Room, SantaState, User } from '../api/types';
import { confirmAction } from '../telegram/webapp';
import { formatMoney, pluralize } from '../utils/format';
import { AmountInput } from './AmountInput';
import { Avatar, AvatarStack } from './Avatar';

type Action = 'open' | 'join' | 'leave' | 'draw' | 'cancel';

/**
 * Тайный Санта в компании: создатель открывает набор (можно с бюджетом),
 * участники записываются, после жеребьёвки каждый видит только своего
 * получателя — бот присылает его и в личку.
 */
export function SantaCard({
  room,
  santa,
  onAction,
  onOpenReceiver,
}: {
  room: Room;
  santa: SantaState | null;
  onAction: (action: Action, budget?: number | null) => Promise<void>;
  onOpenReceiver: (user: User) => void;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [budget, setBudget] = useState(0);
  const [setup, setSetup] = useState(false);

  const run = async (action: Action, value?: number | null) => {
    setBusy(action);
    try {
      await onAction(action, value);
    } finally {
      setBusy(null);
    }
  };

  const spinner = (action: Action) => (busy === action ? <Loader2 size={16} className="animate-spin" /> : null);

  if (!santa) {
    if (!room.is_owner) return null;
    return (
      <div className="rounded-[18px] bg-card p-4" data-santa>
        <div className="flex items-start gap-3">
          <span className="text-[30px] leading-none">🎅</span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold">Тайный Санта</div>
            <p className="mt-0.5 text-[13px] leading-snug text-hint">
              Каждый дарит подарок одному случайному участнику. Кто кому — секрет, даже для вас
            </p>
          </div>
        </div>
        {setup ? (
          <div className="mt-3 space-y-2.5">
            <label className="block rounded-[12px] bg-fill px-3 pt-2 pb-1">
              <span className="text-[12px] text-hint">Бюджет на подарок — необязательно</span>
              <AmountInput
                value={budget}
                onChange={setBudget}
                placeholder="Без ограничений"
                className="block h-8 w-full bg-transparent text-[16px] font-semibold outline-none placeholder:font-normal placeholder:text-hint/70"
              />
            </label>
            <button
              onClick={() => void run('open', budget || null)}
              disabled={busy !== null}
              data-santa-open
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text"
            >
              {spinner('open') ?? 'Открыть набор участников'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setSetup(true)}
            data-santa-start
            className="mt-3 flex h-11 w-full items-center justify-center rounded-[12px] bg-fill text-[15px] font-semibold text-link"
          >
            Запустить Тайного Санту
          </button>
        )}
      </div>
    );
  }

  const count = santa.participants.length;

  if (santa.status === 'open') {
    return (
      <div className="rounded-[18px] bg-card p-4" data-santa>
        <div className="flex items-start gap-3">
          <span className="text-[30px] leading-none">🎅</span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold">Тайный Санта · набор участников</div>
            <p className="mt-0.5 text-[13px] leading-snug text-hint">
              {santa.budget ? `Бюджет до ${formatMoney(santa.budget)}. ` : ''}После жеребьёвки бот напишет каждому, кому
              он дарит
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {count > 0 && <AvatarStack users={santa.participants} size={28} max={6} />}
          <span className="text-[14px] text-hint">{pluralize(count, ['участник', 'участника', 'участников'])}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void run(santa.joined ? 'leave' : 'join')}
            disabled={busy !== null}
            data-santa-join
            className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-[12px] text-[15px] font-semibold ${
              santa.joined ? 'bg-fill' : 'bg-accent text-accent-text'
            }`}
          >
            {spinner('join') ?? spinner('leave') ?? (santa.joined ? '✓ Участвую' : 'Участвую')}
          </button>
          {room.is_owner && (
            <button
              onClick={() => void run('draw')}
              disabled={busy !== null || count < 3}
              data-santa-draw
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[12px] bg-success text-[15px] font-semibold text-white disabled:opacity-50"
            >
              {spinner('draw') ?? 'Жеребьёвка'}
            </button>
          )}
        </div>
        {room.is_owner && (
          <div className="mt-2 flex items-center justify-between text-[13px] text-hint">
            <span>{count < 3 ? 'Для жеребьёвки нужно хотя бы 3 участника' : 'Все записались? Проводите'}</span>
            <button
              onClick={async () => {
                if (await confirmAction('Отменить Тайного Санту?')) void run('cancel');
              }}
              className="text-destructive"
            >
              Отменить
            </button>
          </div>
        )}
      </div>
    );
  }

  // жеребьёвка прошла
  return (
    <div className="rounded-[18px] bg-gold/15 p-4 ring-1 ring-gold/40" data-santa>
      {santa.receiver ? (
        <>
          <div className="text-[13px] font-semibold tracking-wide text-section uppercase">🎅 Вы — Тайный Санта для</div>
          <div className="mt-2.5 flex items-center gap-3">
            <Avatar user={santa.receiver} size={44} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold" data-santa-receiver>
                {santa.receiver.first_name} {santa.receiver.last_name ?? ''}
              </div>
              <div className="text-[13px] text-hint">
                {santa.budget ? `Бюджет до ${formatMoney(santa.budget)} · ` : ''}это секрет
              </div>
            </div>
          </div>
          <button
            onClick={() => onOpenReceiver(santa.receiver!)}
            className="mt-3 flex h-11 w-full items-center justify-center rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text"
          >
            Открыть вишлист
          </button>
          <p className="mt-2 text-center text-[12px] leading-snug text-hint">
            Выберите подарок и нажмите «🎁 Подарю сам» — никто не узнает, что это вы
          </p>
        </>
      ) : (
        <div className="flex items-start gap-3">
          <span className="text-[26px] leading-none">🎅</span>
          <div className="text-[14px] leading-snug">
            Жеребьёвка Тайного Санты прошла — участвуют {pluralize(count, ['человек', 'человека', 'человек'])}
            {santa.joined ? '' : '. Вы в этот раз не участвуете'}
          </div>
        </div>
      )}
      {room.is_owner && (
        <button
          onClick={async () => {
            if (await confirmAction('Отменить жеребьёвку? Пары пропадут, набор начнётся заново.')) void run('cancel');
          }}
          className="mt-2 block w-full text-center text-[13px] text-destructive"
        >
          Отменить жеребьёвку
        </button>
      )}
    </div>
  );
}
