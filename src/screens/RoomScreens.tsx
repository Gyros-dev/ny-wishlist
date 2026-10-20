import { useIsPresent } from 'framer-motion';
import { Check, Copy, LogOut, Plus, Share2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { Bootstrap, Room, RoomPreview, User } from '../api/types';
import { AvatarStack } from '../components/Avatar';
import { Hero } from '../components/Hero';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { Layer, useMainButton } from '../telegram/buttons';
import { hapticNotification, hapticSelection } from '../telegram/webapp';
import { CURRENCIES, currencyInfo, currencySymbolOf, guessCurrency } from '../utils/currencies';
import { pluralize } from '../utils/format';
import { copyText, inviteLink } from '../utils/share';

const STEPS = [
  ['👥', 'Создайте компанию', 'Семья, друзья, коллеги — у каждой компании свои вишлисты и своя валюта'],
  ['🔗', 'Позовите друзей по ссылке', 'Вишлисты увидят только те, кто вступит по приглашению'],
  ['🎁', 'Скидывайтесь вместе', 'Кто сколько вложил, не видно — только на какой подарок уже хватает'],
];

/** Первый запуск: компаний ещё нет. */
export function Onboarding({ me, onCreate }: { me: User; onCreate: () => void }) {
  useMainButton(Layer.home, { text: 'Создать компанию', onClick: onCreate, shine: true });
  return (
    <div className="screen" data-screen="onboarding">
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-3 pb-10">
        <Hero subtitle={`${me.first_name}, загадайте подарки, а друзьям дарите вместе — в складчину`} />
        <div className="rounded-[18px] bg-card p-5">
          <h2 className="text-[19px] font-bold">Как это работает</h2>
          <ol className="mt-4 space-y-4">
            {STEPS.map(([emoji, title, text]) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-fill text-[20px]">
                  {emoji}
                </span>
                <div>
                  <div className="text-[16px] font-semibold">{title}</div>
                  <div className="mt-0.5 text-[14px] leading-snug text-hint">{text}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p className="px-6 text-center text-[14px] leading-snug text-hint">
          Друзья уже собрались? Попросите у них ссылку-приглашение
        </p>
      </div>
    </div>
  );
}

/** Открыли ссылку-приглашение в компанию, где ещё не состоите. */
export function JoinScreen({
  preview,
  joining,
  onJoin,
  onSkip,
}: {
  preview: RoomPreview;
  joining: boolean;
  onJoin: () => void;
  onSkip: () => void;
}) {
  useMainButton(Layer.home, { text: 'Вступить в компанию', onClick: onJoin, loading: joining, shine: true });
  const currency = currencyInfo(preview.currency);
  return (
    <div className="screen flex flex-col" data-screen="join">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <div className="bob text-[68px]">🎄</div>
        <div className="mt-4 text-[15px] text-hint">Вас пригласили в компанию</div>
        <h1 className="mt-1 text-[28px] leading-tight font-bold">{preview.name}</h1>
        {preview.owner && (
          <p className="mt-2 text-[15px] text-hint">{preview.owner.first_name} собирает вишлисты на Новый год</p>
        )}

        <div className="mt-6 w-full rounded-[18px] bg-card p-4 text-left">
          <div className="flex items-center gap-3">
            <AvatarStack users={preview.members_preview} size={36} max={5} />
            <span className="text-[15px] font-medium">
              {pluralize(preview.member_count, ['участник', 'участника', 'участников'])}
            </span>
          </div>
          <div className="mt-4 space-y-2.5 text-[14px] leading-snug">
            <div className="flex gap-2">
              <span className="w-5 shrink-0 text-center font-bold">{currencySymbolOf(preview.currency)}</span>
              <span>
                Цены и взносы — в валюте «{currency.name}»
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-5 shrink-0 text-center">🔒</span>
              <span>Вишлисты видят только участники. Кто сколько скинул — не видит никто</span>
            </div>
          </div>
        </div>

        <button onClick={onSkip} className="mt-5 text-[15px] text-hint">
          Не сейчас
        </button>
      </div>
    </div>
  );
}

// --- создание компании ---------------------------------------------------------

export function CreateRoomSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Новая компания">
      <CreateRoomForm onCreated={onCreated} />
    </Sheet>
  );
}

function CreateRoomForm({ onCreated }: { onCreated: (room: Room) => void }) {
  const isPresent = useIsPresent();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(guessCurrency);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!name.trim()) {
      hapticNotification('error');
      toast('Придумайте название компании', 'error');
      return;
    }
    setSaving(true);
    try {
      const room = await api.createRoom(name, currency);
      hapticNotification('success');
      onCreated(room);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  useMainButton(Layer.sheet, { text: 'Создать компанию', onClick: () => void create(), loading: saving }, isPresent);

  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="overflow-hidden rounded-[14px] bg-card">
        <label className="block px-4 pt-2.5 pb-1">
          <span className="text-[12px] font-medium text-hint">Название</span>
          <input
            name="room-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Друзья · Новый год"
            maxLength={60}
            autoComplete="off"
            className="block w-full bg-transparent pb-1.5 text-[17px] outline-none placeholder:text-hint/70"
          />
        </label>
      </div>

      <div>
        <div className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-section uppercase">Валюта</div>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {CURRENCIES.map((c) => {
            const active = c.code === currency;
            return (
              <button
                type="button"
                key={c.code}
                role="radio"
                aria-checked={active}
                data-currency={c.code}
                onClick={() => {
                  hapticSelection();
                  setCurrency(c.code);
                }}
                className={`flex flex-col items-start rounded-[14px] px-3 py-2.5 text-left transition ${
                  active ? 'bg-accent/12 ring-2 ring-accent' : 'bg-card'
                }`}
              >
                <span className="flex w-full items-center justify-between">
                  <span className="text-[19px] leading-none font-bold">{currencySymbolOf(c.code)}</span>
                  <span className="text-[12px] font-semibold text-hint">{c.code}</span>
                </span>
                <span className="mt-1.5 line-clamp-1 text-[12px] leading-tight text-hint">{c.name}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 px-2 text-center text-[13px] leading-snug text-hint">
          В этой валюте будут все цены и взносы компании. Потом её не поменять
        </p>
      </div>
      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
    </form>
  );
}

// --- список компаний -----------------------------------------------------------

interface RoomsSheetProps {
  open: boolean;
  boot: Bootstrap & { room: Room };
  onClose: () => void;
  onSwitch: (roomId: string) => void;
  onInvite: () => void;
  onCreate: () => void;
  onLeave: () => void;
}

export function RoomsSheet(props: RoomsSheetProps) {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Ваши компании">
      <RoomsContent {...props} />
    </Sheet>
  );
}

function RoomsContent({ boot, onSwitch, onInvite, onCreate, onLeave }: RoomsSheetProps) {
  const isPresent = useIsPresent();
  // шторка без своей кнопки внизу — прячем кнопку экрана под ней
  useMainButton(Layer.sheet, null, isPresent);
  const { room } = boot;
  const link = inviteLink(room.invite_code);

  const copy = async () => {
    if (!link) return;
    if (await copyText(link)) {
      hapticNotification('success');
      toast('Ссылка скопирована', 'success');
    } else {
      toast('Не получилось скопировать — выделите ссылку вручную', 'error');
    }
  };

  return (
    <div className="space-y-4 pb-2" data-rooms-sheet>
      <div className="rounded-[18px] bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[19px] font-bold">{room.name}</div>
            <div className="mt-0.5 text-[14px] text-hint">
              {pluralize(room.member_count, ['участник', 'участника', 'участников'])} · {currencySymbolOf(room.currency)}{' '}
              {room.currency}
              {room.is_owner ? ' · вы создали' : ''}
            </div>
          </div>
        </div>
        {link ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={onInvite}
                data-invite
                className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text"
              >
                <Share2 size={17} /> Пригласить
              </button>
              <button
                onClick={() => void copy()}
                className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-fill text-[15px] font-semibold"
              >
                <Copy size={17} /> Скопировать
              </button>
            </div>
            <div className="mt-3 rounded-[10px] bg-fill px-3 py-2 text-[12px] break-all text-hint select-text">{link}</div>
          </>
        ) : (
          <p className="mt-3 text-[13px] text-destructive">
            Чтобы делиться приглашением, задайте VITE_BOT_USERNAME при сборке
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-section uppercase">Сменить компанию</div>
        <div className="overflow-hidden rounded-[16px] bg-card">
          {boot.rooms.map((r, i) => (
            <button
              key={r.id}
              onClick={() => r.id !== room.id && onSwitch(r.id)}
              data-room={r.name}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-fill ${i ? 'border-t border-separator' : ''}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-fill text-[16px] font-bold">
                {currencySymbolOf(r.currency)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium">{r.name}</span>
                <span className="text-[13px] text-hint">
                  {pluralize(r.member_count, ['участник', 'участника', 'участников'])}
                </span>
              </span>
              {r.id === room.id && <Check size={20} className="shrink-0 text-accent" strokeWidth={3} />}
            </button>
          ))}
          <button
            onClick={onCreate}
            data-create-room
            className="flex w-full items-center gap-3 border-t border-separator px-4 py-3 text-left text-link active:bg-fill"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent/12">
              <Plus size={20} />
            </span>
            <span className="text-[16px] font-medium">Создать новую компанию</span>
          </button>
        </div>
      </div>

      <button
        onClick={onLeave}
        className="flex w-full items-center justify-center gap-2 rounded-[14px] bg-card py-3.5 text-[16px] font-medium text-destructive"
      >
        <LogOut size={18} /> Выйти из «{room.name}»
      </button>
    </div>
  );
}
