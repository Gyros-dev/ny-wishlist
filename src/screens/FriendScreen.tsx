import { motion, useIsPresent } from 'framer-motion';
import { Check, ExternalLink, Loader2, Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { FriendGift, FriendPayload, Member, Supporter } from '../api/types';
import { AmountInput } from '../components/AmountInput';
import { Avatar } from '../components/Avatar';
import { Confetti } from '../components/Confetti';
import { GiftThumb } from '../components/GiftThumb';
import { Lightbox } from '../components/Lightbox';
import { ProgressBar, ProgressPills } from '../components/ProgressBar';
import { toast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { Layer, useBackButton, useMainButton } from '../telegram/buttons';
import { confirmAction, haptic, hapticNotification, hapticSelection, openLink, openTelegramLink } from '../telegram/webapp';
import { copyText } from '../utils/share';
import {
  currencySymbol,
  formatMoney,
  formatShort,
  fullName,
  linkHost,
  plural,
  pluralize,
  quickAmounts,
} from '../utils/format';

const POLL_MS = 4000;
const layoutSpring = { type: 'spring', stiffness: 380, damping: 34 } as const;

interface Props {
  roomId: string;
  friendId: number;
  preview: Member | null;
  onBack: () => void;
  /** что-то поменялось — главному экрану стоит обновиться */
  onChanged: () => void;
  /** меня больше нет в компании */
  onForbidden: () => void;
}

/** Как выглядит подарок с учётом ещё не сохранённой суммы (draft). */
function giftView(gift: FriendGift, draft: number | null) {
  if (draft === null) {
    return {
      othersPct: gift.others_pct,
      minePct: Math.max(0, gift.pct - gift.others_pct),
      pct: gift.pct,
      funded: gift.funded,
    };
  }
  const minePct = (draft * 100) / gift.price;
  const total = gift.others_pct + minePct;
  // others_pct округлён вниз до процента — допускаем эту погрешность
  const funded = total >= 99.95;
  return { othersPct: gift.others_pct, minePct, pct: funded ? 100 : Math.floor(total), funded };
}

export function FriendScreen({ roomId, friendId, preview, onBack, onChanged, onForbidden }: Props) {
  const isPresent = useIsPresent();
  const [data, setData] = useState<FriendPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  // подарок, по которому идёт запрос: голос или бронь
  const [busyId, setBusyId] = useState<string | null>(null);
  const [burst, setBurst] = useState(0);
  const [photo, setPhoto] = useState<{ src: string; caption: string } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);

  // Ответы опроса могут прийти позже ответа на действие пользователя —
  // применяем только то, что отправлено не раньше последнего применённого.
  const seq = useRef(0);
  const applied = useRef(0);
  const dirtyRef = useRef(false);
  const setDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  };
  const hasData = useRef(false);

  const apply = useCallback((s: number, payload: FriendPayload) => {
    if (s < applied.current) return;
    applied.current = s;
    hasData.current = true;
    setData(payload);
    if (!dirtyRef.current) setDraft(payload.my_pledge ?? 0);
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.isForbidden) {
        toast('Вы больше не в этой компании', 'error');
        onForbidden();
        return true;
      }
      return false;
    },
    [onForbidden],
  );

  const load = useCallback(async () => {
    const s = ++seq.current;
    try {
      apply(s, await api.friend(roomId, friendId));
      setLoadError(null);
    } catch (err) {
      if (!handleError(err) && !hasData.current) setLoadError(errorMessage(err));
    }
  }, [roomId, friendId, apply, handleError]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(load, POLL_MS, isPresent && !saving && busyId === null);

  const saved = data?.my_pledge ?? 0;
  const changed = dirty && draft !== saved;
  const allGifts = data?.gifts ?? [];
  // забронированные дарят отдельно — в общем сборе и голосовании их нет
  const gifts = allGifts.filter((g) => !g.reserved);
  const reservedGifts = allGifts.filter((g) => g.reserved);
  const isSupporter = saved > 0;
  const views = gifts.map((g) => giftView(g, changed ? draft : null));
  const fundedCount = views.filter((v) => v.funded).length;

  const onDraft = (value: number) => {
    setDraft(value);
    setDirty(true);
  };

  const savePledge = async (amount: number) => {
    if (!data) return;
    const fundedBefore = new Set(data.gifts.filter((g) => g.funded).map((g) => g.id));
    const joining = saved === 0 && amount > 0;
    setSaving(true);
    const s = ++seq.current;
    try {
      const res = await api.setPledge(roomId, friendId, amount);
      setDirty(false);
      apply(s, res);
      onChanged();
      if (amount > 0) {
        hapticNotification('success');
        const unlocked = res.gifts.filter((g) => g.funded && !fundedBefore.has(g.id));
        if (unlocked.length || joining) setBurst((b) => b + 1);
        const best = unlocked[unlocked.length - 1];
        toast(best ? `Теперь хватает на ${best.emoji} ${best.title}!` : 'Вы в деле! Сумму видите только вы', 'success');
      } else {
        toast('Вы вышли из сбора');
      }
    } catch (err) {
      if (!handleError(err)) {
        hapticNotification('error');
        toast(errorMessage(err), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    if (await confirmAction('Выйти из сбора? Ваши голоса тоже отменятся.')) void savePledge(0);
  };

  const vote = async (gift: FriendGift) => {
    if (!data || busyId) return;
    const on = !gift.my_vote;
    haptic('medium');
    setBusyId(gift.id);
    const s = ++seq.current;
    try {
      apply(s, await api.vote(roomId, friendId, gift.id, on));
      onChanged();
      if (on) toast(`Голос за ${gift.emoji} ${gift.title}. Можно выбрать несколько`, 'success');
    } catch (err) {
      if (!handleError(err)) toast(errorMessage(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const savePoolChat = async (link: string) => {
    setChatBusy(true);
    const s = ++seq.current;
    try {
      apply(s, await api.setPoolChat(roomId, friendId, link));
      hapticNotification('success');
      toast(link ? 'Ссылка на чат сохранена — её видят участники сбора' : 'Ссылка на чат убрана', 'success');
      return true;
    } catch (err) {
      if (!handleError(err)) toast(errorMessage(err), 'error');
      return false;
    } finally {
      setChatBusy(false);
    }
  };

  const reserve = async (gift: FriendGift, on: boolean) => {
    if (!data || busyId) return;
    const question = on
      ? `Подарить «${gift.title}» самому, без общего сбора? Другие увидят, что подарок кто-то дарит, но не узнают кто.`
      : `Снять бронь с «${gift.title}»? Подарок вернётся в общий сбор.`;
    if (!(await confirmAction(question))) return;
    haptic('medium');
    setBusyId(gift.id);
    const s = ++seq.current;
    try {
      apply(s, await api.reserveGift(roomId, gift.id, on));
      onChanged();
      hapticNotification('success');
      toast(
        on
          ? `${gift.emoji} ${gift.title} — дарите вы. Никто не узнает, что это вы`
          : 'Бронь снята — подарок снова в общем сборе',
        'success',
      );
    } catch (err) {
      if (!handleError(err)) {
        hapticNotification('error');
        toast(errorMessage(err), 'error');
        void load();
      }
    } finally {
      setBusyId(null);
    }
  };

  let mainButton = null;
  if (data && changed) {
    if (draft > 0) {
      mainButton = {
        text: saved ? `Изменить вклад на ${formatMoney(draft)}` : `Скинуться ${formatMoney(draft)}`,
        onClick: () => void savePledge(draft),
        loading: saving,
        shine: !saved,
      };
    } else if (saved > 0) {
      mainButton = { text: 'Выйти из сбора', onClick: () => void leave(), loading: saving };
    }
  }
  useMainButton(Layer.friend, mainButton, isPresent);
  useBackButton(Layer.friend, isPresent ? onBack : null);

  const friend = data?.friend ?? preview;
  // итоговый набор считает сервер: по голосам и в пределах общего бюджета
  const picked = gifts.filter((g) => g.picked);
  const pickedText = picked.map((g) => `${g.emoji} ${g.title}`).join(' + ');

  return (
    <div className="screen" data-screen="friend">
      <Confetti burst={burst} />
      <Lightbox src={photo?.src ?? null} caption={photo?.caption} onClose={() => setPhoto(null)} />
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-4 pb-12">
        {friend && (
          <div className="flex flex-col items-center pt-1 text-center">
            <Avatar user={friend} size={80} />
            <h1 className="mt-3 text-[22px] leading-tight font-bold">{fullName(friend)}</h1>
            <div className="mt-0.5 text-[14px] text-hint">
              {friend.username ? `@${friend.username} · ` : ''}
              {data ? pluralize(allGifts.length, ['подарок', 'подарка', 'подарков']) : 'вишлист'}
            </div>
          </div>
        )}

        {!data ? (
          loadError ? (
            <div className="rounded-[18px] bg-card p-6 text-center">
              <p className="text-[15px]">{loadError}</p>
              <button onClick={() => void load()} className="mt-3 text-[16px] font-medium text-link">
                Повторить
              </button>
            </div>
          ) : (
            <>
              <div className="shimmer h-[112px] rounded-[18px]" />
              <div className="shimmer h-[176px] rounded-[18px]" />
              <div className="shimmer h-[132px] rounded-[18px]" />
            </>
          )
        ) : (
          <>
            {/* На что хватает — без сумм */}
            {allGifts.length > 0 && (
              <div className="rounded-[18px] bg-card p-4" data-summary>
                {gifts.length > 0 ? (
                  <>
                    <div className="text-[13px] font-medium text-hint">
                      {changed ? 'С вашим вкладом хватит' : 'Уже хватает'}
                    </div>
                    <div className="mt-0.5 text-[26px] leading-tight font-bold">
                      на <span className="tabular">{fundedCount}</span> из {gifts.length}{' '}
                      {plural(gifts.length, ['подарка', 'подарков', 'подарков'])}
                    </div>
                    <div className="mt-3">
                      <ProgressPills progress={views.map((v) => v.pct)} />
                    </div>
                  </>
                ) : (
                  <div className="text-[19px] leading-snug font-bold">Все подарки уже кто-то дарит сам 🎁</div>
                )}
                {reservedGifts.length > 0 && gifts.length > 0 && (
                  <div className="mt-2 text-[13px] text-hint">
                    + {pluralize(reservedGifts.length, ['подарок', 'подарка', 'подарков'])} кто-то дарит сам, без
                    общего сбора
                  </div>
                )}
                <div className="mt-3 flex items-start gap-2 text-[13px] leading-snug text-hint">
                  <Lock size={14} className="mt-[1px] shrink-0" />
                  <span>Суммы скрыты от всех — видно только, на что хватает</span>
                </div>
              </div>
            )}

            {/* Мой вклад */}
            <div className="rounded-[18px] bg-card p-4">
              <label htmlFor="pledge" className="text-[16px] font-semibold">
                Сколько готовы потратить?
              </label>
              <p className="mt-0.5 text-[13px] leading-snug text-hint">
                Вашу сумму не увидит никто — ни {friend?.first_name ?? 'владелец вишлиста'}, ни другие участники
              </p>
              <div className="mt-3 flex items-center rounded-[14px] bg-fill px-4 focus-within:ring-2 focus-within:ring-accent">
                <AmountInput
                  id="pledge"
                  value={draft}
                  onChange={onDraft}
                  placeholder="0"
                  className="h-14 w-full bg-transparent text-[26px] leading-[56px] font-bold outline-none placeholder:text-hint/60"
                />
                <span className="text-[24px] font-bold text-hint">{currencySymbol()}</span>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {quickAmounts().map((v) => (
                  <button
                    key={v}
                    onClick={() => {
                      hapticSelection();
                      onDraft(v);
                    }}
                    className={`tabular h-9 rounded-full text-[14px] font-semibold transition ${
                      draft === v ? 'bg-accent text-accent-text' : 'bg-fill'
                    }`}
                  >
                    {formatShort(v)}
                  </button>
                ))}
              </div>
              {changed ? (
                <p className="mt-3 text-[13px] leading-snug text-accent">
                  Шкалы ниже уже учитывают эту сумму. Подтвердите кнопкой внизу
                </p>
              ) : isSupporter ? (
                <div className="mt-3 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[14px] font-semibold text-success">
                    <Check size={16} strokeWidth={3} /> Вы участвуете в сборе
                  </span>
                  <button onClick={() => void leave()} className="text-[14px] text-destructive">
                    Выйти
                  </button>
                </div>
              ) : null}
            </div>

            {data.supporters && (
              <PoolTeam
                supporters={data.supporters}
                chat={data.pool_chat}
                busy={chatBusy}
                onSaveChat={savePoolChat}
              />
            )}

            {/* Подарки */}
            <section>
              <div className="mb-2 flex items-end justify-between px-1">
                <h2 className="text-[13px] font-semibold tracking-wide text-section uppercase">Вишлист</h2>
                <span className="text-[13px] text-hint">по цене</span>
              </div>

              {data.decided ? (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 rounded-[16px] bg-gold/20 px-4 py-3 text-[15px] leading-snug"
                  data-decision
                >
                  🎉 <b>Все участники сбора проголосовали</b> —{' '}
                  {picked.length ? <>покупаем {pickedText}</> : 'но на выбранные подарки пока не хватает'}
                </motion.div>
              ) : picked.length > 0 ? (
                <div className="mb-3 rounded-[16px] bg-gold/12 px-4 py-3 text-[14px] leading-snug" data-picked-preview>
                  🏆 По голосам сейчас: <b>{pickedText}</b>
                  {picked.length > 1 ? ' — общего бюджета хватает на всё это' : ''}
                </div>
              ) : null}
              {!isSupporter && gifts.length > 0 && (
                <div className="mb-3 rounded-[16px] bg-accent/10 px-4 py-3 text-[14px] leading-snug text-accent">
                  Укажите сумму — и сможете голосовать, увидите других участников сбора и их чат
                </div>
              )}

              <div className="space-y-3">
                {gifts.flatMap((g, i) => {
                  const card = (
                    <GiftCard
                      key={g.id}
                      gift={g}
                      view={views[i]}
                      fundedByDraft={changed && views[i].funded && !g.funded}
                      canVote={isSupporter}
                      busy={busyId === g.id}
                      disabled={busyId !== null}
                      onVote={() => void vote(g)}
                      onReserve={() => void reserve(g, true)}
                      onOpenPhoto={(src) => setPhoto({ src, caption: `${g.title} · ${formatMoney(g.price)}` })}
                    />
                  );
                  return i === fundedCount && i > 0 ? [<BudgetLine key="budget-line" />, card] : [card];
                })}
                {allGifts.length === 0 && (
                  <div className="rounded-[18px] bg-card p-6 text-center text-[15px] text-hint">
                    В вишлисте пока пусто
                  </div>
                )}
              </div>
            </section>

            {reservedGifts.length > 0 && (
              <section data-reserved-section>
                <div className="mb-2 flex items-end justify-between px-1">
                  <h2 className="text-[13px] font-semibold tracking-wide text-section uppercase">Дарят отдельно</h2>
                  <span className="text-[13px] text-hint">кто — не видно</span>
                </div>
                <div className="space-y-3">
                  {reservedGifts.map((g) => (
                    <ReservedCard
                      key={g.id}
                      gift={g}
                      busy={busyId === g.id}
                      onCancel={() => void reserve(g, false)}
                      onOpenPhoto={(src) => setPhoto({ src, caption: `${g.title} · ${formatMoney(g.price)}` })}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BudgetLine() {
  return (
    <motion.div
      layout
      transition={layoutSpring}
      className="flex items-center gap-2 px-1 text-[12px] font-semibold tracking-wide text-success uppercase"
      data-budget-line
    >
      <span className="h-px flex-1 border-t border-dashed border-success/60" />
      <span>↑ на это уже хватает</span>
      <span className="h-px flex-1 border-t border-dashed border-success/60" />
    </motion.div>
  );
}

function GiftCard({
  gift,
  view,
  fundedByDraft,
  canVote,
  busy,
  disabled,
  onVote,
  onReserve,
  onOpenPhoto,
}: {
  gift: FriendGift;
  view: ReturnType<typeof giftView>;
  fundedByDraft: boolean;
  canVote: boolean;
  busy: boolean;
  disabled: boolean;
  onVote: () => void;
  onReserve: () => void;
  onOpenPhoto: (src: string) => void;
}) {
  const voted = gift.my_vote;
  const votePct = gift.vote_pct ?? 0;

  return (
    <motion.div
      layout
      transition={layoutSpring}
      className={`rounded-[18px] bg-card p-4 ${gift.picked ? 'ring-2 ring-gold' : ''}`}
      data-gift={gift.title}
    >
      <div className="flex gap-3">
        <GiftThumb gift={gift} size={60} radius={14} onOpen={onOpenPhoto} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[16px] leading-snug font-semibold">{gift.title}</div>
            {gift.picked && (
              <span className="shrink-0 rounded-full bg-gold px-2 py-0.5 text-[12px] font-bold text-[#3b2600]" data-picked>
                ✓ В покупке
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[14px]">
            <span className="tabular font-semibold">{formatMoney(gift.price)}</span>
            {gift.link && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openLink(gift.link!);
                }}
                data-link
                className="-mx-1.5 -my-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-link active:opacity-60"
              >
                <ExternalLink size={13} />
                {linkHost(gift.link)}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar othersPct={view.othersPct} minePct={view.minePct} funded={view.funded} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[13px]">
        {view.funded ? (
          <span className="flex items-center gap-1 font-semibold text-success">
            <Check size={14} strokeWidth={3} />
            {fundedByDraft ? 'Хватит с вашим вкладом' : 'Хватает'}
          </span>
        ) : (
          <span className="text-hint">Пока не хватает</span>
        )}
        <span className="tabular font-semibold text-hint">{view.pct}%</span>
      </div>

      {(canVote || votePct > 0) && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-separator pt-3">
          <div className="min-w-0 flex-1 text-[13px] text-hint" data-vote-pct={votePct}>
            {votePct > 0 ? (
              <div className="flex items-center gap-2">
                <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-fill">
                  <motion.span
                    className="absolute inset-y-0 left-0 rounded-full bg-gold"
                    initial={false}
                    animate={{ width: `${votePct}%` }}
                  />
                </span>
                <span className="tabular whitespace-nowrap">{votePct}% за</span>
              </div>
            ) : (
              'Пока без голосов'
            )}
          </div>
          {canVote && (
            <button
              onClick={onVote}
              disabled={disabled}
              data-vote
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold transition active:scale-95 ${
                voted ? 'bg-success text-white' : 'bg-accent/12 text-accent'
              }`}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : voted ? (
                <>
                  <Check size={16} strokeWidth={3} /> Мой голос
                </>
              ) : (
                'Голосовать'
              )}
            </button>
          )}
        </div>
      )}

      <button
        onClick={onReserve}
        disabled={disabled}
        data-reserve
        className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-[12px] bg-fill text-[14px] font-semibold transition active:scale-[0.98]"
      >
        🎁 Подарю сам, целиком
      </button>
    </motion.div>
  );
}

/** Подарок, который кто-то дарит сам. Кто именно — знает только он. */
function ReservedCard({
  gift,
  busy,
  onCancel,
  onOpenPhoto,
}: {
  gift: FriendGift;
  busy: boolean;
  onCancel: () => void;
  onOpenPhoto: (src: string) => void;
}) {
  return (
    <motion.div
      layout
      transition={layoutSpring}
      className={`rounded-[18px] p-4 ${gift.reserved_by_me ? 'bg-gold/15 ring-2 ring-gold/60' : 'bg-card'}`}
      data-reserved-gift={gift.title}
    >
      <div className="flex gap-3">
        <span className={gift.reserved_by_me ? '' : 'opacity-60'}>
          <GiftThumb gift={gift} size={48} radius={12} onOpen={onOpenPhoto} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[15px] leading-snug font-semibold ${gift.reserved_by_me ? '' : 'text-hint'}`}>
            {gift.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[14px]">
            <span className="tabular text-hint">{formatMoney(gift.price)}</span>
            {gift.link && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openLink(gift.link!);
                }}
                data-link
                className="-mx-1.5 -my-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-link active:opacity-60"
              >
                <ExternalLink size={13} />
                {linkHost(gift.link)}
              </button>
            )}
          </div>
        </div>
      </div>
      {gift.reserved_by_me ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[14px] font-semibold">🎁 Этот подарок дарите вы</span>
          <button onClick={onCancel} disabled={busy} className="text-[14px] text-destructive" data-unreserve>
            {busy ? <Loader2 size={16} className="animate-spin" /> : 'Снять бронь'}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1.5 text-[14px] text-hint">
          <Lock size={14} /> Кто-то уже дарит этот подарок сам
        </div>
      )}
    </motion.div>
  );
}

/** Кто скидывается вместе со мной и ссылка на их Telegram-группу. Видят только участники сбора. */
function PoolTeam({
  supporters,
  chat,
  busy,
  onSaveChat,
}: {
  supporters: Supporter[];
  chat: FriendPayload['pool_chat'];
  busy: boolean;
  onSaveChat: (link: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState('');
  const usernames = supporters.filter((s) => !s.is_me && s.username).map((s) => `@${s.username}`);
  const showForm = !chat || editing;

  const save = async (value: string) => {
    if (await onSaveChat(value)) {
      setEditing(false);
      setLink('');
    }
  };

  const copy = async () => {
    if (await copyText(usernames.join(' '))) toast(`Скопировано: ${usernames.join(' ')}`, 'success');
    else toast('Не получилось скопировать', 'error');
  };

  return (
    <div className="rounded-[18px] bg-card p-4" data-pool-team>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[16px] font-semibold">Скидываются вместе</h3>
        <span className="text-[13px] text-hint">
          {pluralize(supporters.length, ['участник', 'участника', 'участников'])}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] leading-snug text-hint">
        Список видят только участники сбора. Кто сколько вложил — не видит никто
      </p>

      <div className="mt-2.5 -mx-2">
        {supporters.map((s) => {
          const canWrite = !s.is_me && !!s.username;
          return (
            <button
              key={s.id}
              onClick={() => canWrite && openTelegramLink(`https://t.me/${s.username}`)}
              disabled={!canWrite}
              data-supporter={s.first_name}
              className={`flex w-full items-center gap-3 rounded-[12px] px-2 py-1.5 text-left ${canWrite ? 'active:bg-fill' : ''}`}
            >
              <Avatar user={s} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">
                  {fullName(s)}
                  {s.is_me ? <span className="text-hint"> · вы</span> : null}
                </span>
                <span className="block truncate text-[13px] text-hint">
                  {s.username ? `@${s.username}` : 'без username в Telegram'}
                </span>
              </span>
              {canWrite && <span className="shrink-0 text-[13px] font-semibold text-link">Написать</span>}
            </button>
          );
        })}
      </div>

      <div className="mt-3 border-t border-separator pt-3">
        {!showForm && chat ? (
          <>
            <button
              onClick={() => openTelegramLink(chat.link)}
              data-open-pool-chat
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text transition active:scale-[0.98]"
            >
              💬 Открыть чат сбора
            </button>
            <div className="mt-2 flex items-center justify-between gap-2 text-[13px] text-hint">
              <span className="truncate">
                {chat.set_by ? `Группу добавил(а) ${chat.set_by.first_name}` : 'Группа участников сбора'}
              </span>
              <button
                onClick={() => {
                  setLink(chat.link);
                  setEditing(true);
                }}
                className="shrink-0 text-link"
              >
                Изменить
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[15px] font-semibold">Чат, чтобы договориться о покупке</div>
            <p className="mt-0.5 text-[13px] leading-snug text-hint">
              Создайте группу в Telegram, добавьте участников и вставьте ссылку-приглашение из настроек группы — её
              увидят только участники сбора
            </p>
            <form
              className="mt-2.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save(link);
              }}
            >
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="t.me/+…"
                inputMode="url"
                autoCapitalize="off"
                autoComplete="off"
                data-pool-chat-input
                className="h-11 min-w-0 flex-1 rounded-[12px] bg-fill px-3 text-[16px] outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                type="submit"
                disabled={busy || !link.trim()}
                className="flex h-11 shrink-0 items-center rounded-[12px] bg-accent px-4 text-[15px] font-semibold text-accent-text disabled:opacity-50"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : 'Сохранить'}
              </button>
            </form>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              {usernames.length > 0 && (
                <button onClick={() => void copy()} className="font-semibold text-link">
                  Скопировать {usernames.length === 1 ? 'username участника' : 'username участников'}
                </button>
              )}
              {chat && editing && (
                <>
                  <button onClick={() => void save('')} className="text-destructive">
                    Убрать ссылку
                  </button>
                  <button onClick={() => setEditing(false)} className="text-hint">
                    Отмена
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
