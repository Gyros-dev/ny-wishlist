import { motion, useIsPresent } from 'framer-motion';
import { Check, ExternalLink, Loader2, Lock, MessageCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, prepareChat } from '../api/client';
import type { FriendGift, FriendPayload, Member, Occasion, Supporter } from '../api/types';
import { AmountInput } from '../components/AmountInput';
import { Avatar } from '../components/Avatar';
import { Confetti } from '../components/Confetti';
import { GiftThumb } from '../components/GiftThumb';
import { Lightbox } from '../components/Lightbox';
import { ProgressBar, ProgressPills } from '../components/ProgressBar';
import { toast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { Layer, useBackButton, useMainButton } from '../telegram/buttons';
import {
  allowsWriteToPm,
  confirmAction,
  haptic,
  hapticNotification,
  hapticSelection,
  openLink,
  openTelegramLink,
  requestChat,
  requestWriteAccess,
  supportsRequestChat,
} from '../telegram/webapp';
import { daysUntilBirthday, formatBirthday, inDaysText, parseBirthday } from '../utils/birthday';
import { copyText, startGroupLink } from '../utils/share';
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
  /** в компании дней рождения в шапке — дата и сколько до неё */
  occasion: Occasion;
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
      missing: gift.missing,
      togetherMissing: gift.together_missing ?? 0,
      extraMissing: gift.extra_missing,
    };
  }
  const missing = Math.max(0, gift.others_missing - draft);
  const funded = missing === 0;
  const pct = funded ? 100 : Math.min(99, Math.floor(((gift.price - missing) * 100) / gift.price));
  return {
    othersPct: gift.others_pct,
    minePct: (draft * 100) / gift.price,
    pct,
    funded,
    missing,
    togetherMissing: Math.max(0, (gift.together_others_missing ?? 0) - draft),
    extraMissing: gift.extra_others_missing === null ? null : Math.max(0, gift.extra_others_missing - draft),
  };
}

export function FriendScreen({ roomId, occasion, friendId, preview, onBack, onChanged, onForbidden }: Props) {
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
  const [creatingChat, setCreatingChat] = useState(false);
  const [purchaseBusy, setPurchaseBusy] = useState(false);

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
  // забронированные дарят отдельно, подаренные уже не нужны — в общем сборе их нет
  const gifts = allGifts.filter((g) => !g.reserved && !g.received);
  const reservedGifts = allGifts.filter((g) => g.reserved && !g.received);
  const receivedGifts = allGifts.filter((g) => g.received);
  const isSupporter = saved > 0;
  const closed = data?.purchase?.status === 'bought';
  const views = gifts.map((g) => giftView(g, changed ? draft : null));
  const fundedCount = views.filter((v) => v.funded).length;
  // Сколько подарков можно купить сразу: самые недорогие, пока хватает денег.
  // Подарки идут по возрастанию цены, так что это всегда первые N.
  const togetherCount = views.filter((v) => v.togetherMissing === 0).length;
  const togetherSet = gifts.slice(0, togetherCount);
  const allFunded = gifts.length > 0 && togetherCount === gifts.length;
  // следующий подарок, который можно добавить к набору, и сколько на него нужно вложить мне
  const nextGift = togetherCount < gifts.length ? gifts[togetherCount] : null;
  const nextMissing = nextGift ? views[togetherCount].togetherMissing : 0;
  const nextTopUp = nextGift?.together_others_missing ?? 0;

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

  const purchase = async (action: 'take' | 'release' | 'bought' | 'reopen') => {
    if (purchaseBusy) return;
    if (action === 'bought' && !(await confirmAction('Отметить, что подарок куплен? Сбор закроется — взносы и голоса больше не поменять.'))) return;
    setPurchaseBusy(true);
    const s = ++seq.current;
    try {
      apply(s, await api.poolPurchase(roomId, friendId, action));
      onChanged();
      hapticNotification('success');
      const messages = {
        take: 'Покупка за вами — остальные участники видят, кому переводить',
        release: 'Вы больше не покупаете — покупку может взять кто-то другой',
        bought: '🎉 Подарок куплен — сбор закрыт',
        reopen: 'Сбор снова открыт',
      } as const;
      toast(messages[action], 'success');
      if (action === 'bought') setBurst((b) => b + 1);
    } catch (err) {
      if (!handleError(err)) toast(errorMessage(err), 'error');
    } finally {
      setPurchaseBusy(false);
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

  // «Создать чат сбора»: системный выбор/создание чата (Bot API 9.6+),
  // на старых клиентах — ссылка «добавить бота в группу»
  const createChat = async () => {
    if (creatingChat) return;
    setCreatingChat(true);
    try {
      const { buttonId, startParam } = await prepareChat(roomId, friendId);
      if (buttonId && supportsRequestChat()) {
        if (await requestChat(buttonId)) {
          hapticNotification('success');
          toast('Чат выбран — бот разошлёт приглашения участникам сбора', 'success');
          window.setTimeout(() => void load(), 2500);
        }
        return;
      }
      const link = startGroupLink(startParam);
      if (!link) {
        toast('Чтобы создать чат, задайте VITE_BOT_USERNAME', 'error');
        return;
      }
      openTelegramLink(link);
      toast('Выберите или создайте группу и добавьте в неё бота — он разошлёт приглашения');
    } catch (err) {
      if (!handleError(err)) toast(errorMessage(err), 'error');
    } finally {
      setCreatingChat(false);
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
  if (data && changed && !closed) {
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
  // подарки, на которые хватит в придачу к выбранным по голосам
  const extras = closed ? [] : gifts.filter((g, i) => !g.picked && views[i].extraMissing === 0);
  const extrasText = extras.map((g) => `${g.emoji} ${g.title}`).join(', ');
  const extrasHint = extras.length > 0 && (
    <div className="mt-1 text-[14px] leading-snug" data-extras>
      ✨ Хватит ещё и на: <b>{extrasText}</b>
      {isSupporter && !closed && (
        <span className="text-hint"> — проголосуйте, чтобы добавить в покупку</span>
      )}
    </div>
  );

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
            {occasion === 'birthdays' && <FriendBirthday birthday={friend.birthday ?? null} />}
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
            {/* На что хватает */}
            {allGifts.length > 0 && (
              <div className="rounded-[18px] bg-card p-4" data-summary>
                {closed ? (
                  <div className="text-[19px] leading-snug font-bold text-success" data-closed>
                    🎉 Подарок куплен — сбор закрыт
                  </div>
                ) : gifts.length > 0 ? (
                  <>
                    {allFunded ? (
                      <div data-all-funded>
                        <div className="text-[22px] leading-tight font-bold text-success">
                          ✓ Хватает на все подарки сразу
                        </div>
                        <div className="mt-1 text-[14px] text-hint">
                          {isSupporter || changed
                            ? 'Осталось выбрать и купить'
                            : 'Сбор уже полный — можно не скидываться'}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-[13px] font-medium text-hint">
                          {togetherCount === 0
                            ? changed
                              ? 'С вашим вкладом'
                              : 'Пока'
                            : `${changed ? 'С вашим вкладом хватит' : 'Уже хватает'}${togetherCount > 1 ? ' сразу' : ''}`}
                        </div>
                        <div
                          className={`mt-0.5 leading-tight font-bold ${togetherCount === 0 ? 'text-[22px]' : 'text-[26px]'}`}
                          data-together={togetherCount}
                        >
                          {togetherCount === 0 ? (
                            'не хватает ни на один подарок'
                          ) : (
                            <>
                              на <span className="tabular">{togetherCount}</span>{' '}
                              {plural(togetherCount, ['подарок', 'подарка', 'подарков'])} из {gifts.length}
                            </>
                          )}
                        </div>
                        {togetherCount === 1 && fundedCount > 1 ? (
                          <div className="mt-1 text-[14px] leading-snug" data-together-set>
                            На любой из {fundedCount} с отметкой ✓ — но только на один
                          </div>
                        ) : (
                          togetherCount > 0 && (
                            <div className="mt-1 line-clamp-3 text-[14px] leading-snug" data-together-set>
                              {togetherSet.map((g) => `${g.emoji} ${g.title}`).join(' + ')}
                            </div>
                          )
                        )}
                        {nextGift && (
                          <div className="mt-1 text-[14px] leading-snug text-hint" data-next-missing>
                            {togetherCount === 0 ? `До «${nextGift.title}»` : `Чтобы хватило ещё и на «${nextGift.title}»,`} не
                            хватает <b className="tabular text-text">{formatMoney(nextMissing)}</b>
                          </div>
                        )}
                      </>
                    )}
                    <div className="mt-3">
                      <ProgressPills progress={views.map((v) => v.pct)} />
                    </div>
                  </>
                ) : (
                  <div className="text-[19px] leading-snug font-bold">
                    {receivedGifts.length && !reservedGifts.length ? 'Все подарки уже подарили 🎉' : 'Все подарки уже кто-то дарит сам 🎁'}
                  </div>
                )}
                {reservedGifts.length > 0 && gifts.length > 0 && (
                  <div className="mt-2 text-[13px] text-hint">
                    + {pluralize(reservedGifts.length, ['подарок', 'подарка', 'подарков'])} кто-то дарит сам, без
                    общего сбора
                  </div>
                )}
                <div className="mt-3 flex items-start gap-2 text-[13px] leading-snug text-hint">
                  <Lock size={14} className="mt-[1px] shrink-0" />
                  <span>Сколько вложил каждый, не видит никто — ни {friend?.first_name ?? 'владелец'}, ни участники</span>
                </div>
              </div>
            )}

            {/* Мой вклад */}
            {closed ? (
              isSupporter && (
                <div className="flex items-center justify-between rounded-[18px] bg-card px-4 py-3.5">
                  <span className="flex items-center gap-1.5 text-[15px] font-semibold text-success">
                    <Check size={16} strokeWidth={3} /> Вы участвовали в сборе
                  </span>
                  <span className="tabular text-[15px] text-hint">{formatMoney(saved)}</span>
                </div>
              )
            ) : (
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
              {nextGift && nextTopUp > 0 && draft !== nextTopUp && (
                <button
                  onClick={() => {
                    hapticSelection();
                    onDraft(nextTopUp);
                  }}
                  data-top-up
                  className="mt-3 flex w-full items-center justify-between gap-2 rounded-[12px] bg-accent/10 px-3 py-2.5 text-left text-[14px] text-accent"
                >
                  <span className="min-w-0 truncate">
                    Чтобы хватило {togetherCount > 0 ? 'ещё и ' : ''}на {nextGift.emoji} {nextGift.title}
                  </span>
                  <b className="tabular shrink-0">{formatMoney(nextTopUp)}</b>
                </button>
              )}
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
            )}

            {data.supporters && (
              <PoolTeam
                supporters={data.supporters}
                chat={data.pool_chat}
                busy={chatBusy}
                creating={creatingChat}
                onSaveChat={savePoolChat}
                onCreateChat={() => void createChat()}
              />
            )}

            {isSupporter && (data.purchase || picked.length > 0) && (
              <PurchaseCard
                purchase={data.purchase}
                pickedText={pickedText}
                busy={purchaseBusy}
                onAction={(action) => void purchase(action)}
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
                  {extrasHint}
                </motion.div>
              ) : picked.length > 0 && !closed ? (
                <div className="mb-3 rounded-[16px] bg-gold/12 px-4 py-3 text-[14px] leading-snug" data-picked-preview>
                  🏆 По голосам сейчас: <b>{pickedText}</b>
                  {picked.length > 1 ? ' — денег хватает на всё это вместе' : ''}
                  {extrasHint}
                </div>
              ) : null}
              {!isSupporter && !closed && gifts.length > 0 && (
                <div className="mb-3 rounded-[16px] bg-accent/10 px-4 py-3" data-how-to>
                  <div className="text-[14px] font-semibold text-accent">Как скинуться вместе</div>
                  <ol className="mt-1.5 space-y-1 text-[13px] leading-snug">
                    <li>1. Впишите выше, сколько готовы потратить</li>
                    <li>2. Голосуйте за подарки — можно за несколько</li>
                    <li>3. Договоритесь в чате сбора, кто покупает</li>
                  </ol>
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
                      canVote={isSupporter && !closed}
                      showExtra={!closed}
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

            {receivedGifts.length > 0 && (
              <section data-received-section>
                <div className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-section uppercase">
                  🎉 Уже подарили
                </div>
                <div className="overflow-hidden rounded-[16px] bg-card opacity-70">
                  {receivedGifts.map((g, i) => (
                    <div key={g.id} className={`flex items-center gap-3 px-4 py-2.5 ${i ? 'border-t border-separator' : ''}`}>
                      <GiftThumb gift={g} size={36} radius={10} />
                      <span className="min-w-0 flex-1 truncate text-[15px]">{g.title}</span>
                      <span className="tabular text-[14px] text-hint">{formatMoney(g.price)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

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
  showExtra,
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
  showExtra: boolean;
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
            {gift.picked ? (
              <span className="shrink-0 rounded-full bg-gold px-2 py-0.5 text-[12px] font-bold text-[#3b2600]" data-picked>
                ✓ В покупке
              </span>
            ) : (
              gift.must_have && (
                <span className="shrink-0 rounded-full bg-gold/25 px-2 py-0.5 text-[12px] font-semibold" data-must-have>
                  ⭐ Очень хочет
                </span>
              )
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
          {gift.note && (
            <div className="mt-1.5 flex gap-1.5 text-[13px] leading-snug text-hint" data-note>
              <MessageCircle size={13} className="mt-[3px] shrink-0" />
              <span className="min-w-0">{gift.note}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar othersPct={view.othersPct} minePct={view.minePct} funded={view.funded} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[13px]">
        {view.funded && showExtra && !gift.picked && view.extraMissing !== null ? (
          view.extraMissing === 0 ? (
            <span className="flex items-center gap-1 font-semibold text-success" data-fits-extra>
              <Plus size={14} strokeWidth={3} />
              Хватит и вместе с выбранным
            </span>
          ) : (
            <span className="min-w-0 leading-snug text-hint" data-extra-missing>
              <span className="font-semibold text-success">✓ Хватает отдельно</span> · вместе с выбранным не хватает{' '}
              <b className="tabular text-text">{formatMoney(view.extraMissing)}</b>
            </span>
          )
        ) : view.funded ? (
          <span className="flex items-center gap-1 font-semibold text-success">
            <Check size={14} strokeWidth={3} />
            {fundedByDraft ? 'Хватит с вашим вкладом' : 'Хватает'}
          </span>
        ) : (
          <span className="text-hint">
            Не хватает <b className="tabular text-text">{formatMoney(view.missing)}</b>
          </span>
        )}
        <span className="tabular shrink-0 font-semibold text-hint">{view.pct}%</span>
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

      <div className="mt-2 -mb-1 flex justify-end">
        <button
          onClick={onReserve}
          disabled={disabled}
          data-reserve
          className="rounded-full px-2 py-1 text-[13px] font-semibold text-link transition active:opacity-60"
        >
          🎁 Подарю сам, целиком
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Кто покупает подарок от всего сбора. Покупатель отмечает «Куплено» —
 * сбор закрывается; остальные видят, кому переводить свою часть.
 */
function PurchaseCard({
  purchase,
  pickedText,
  busy,
  onAction,
}: {
  purchase: FriendPayload['purchase'];
  pickedText: string;
  busy: boolean;
  onAction: (action: 'take' | 'release' | 'bought' | 'reopen') => void;
}) {
  const gifts = purchase ? purchase.gifts.map((g) => `${g.emoji} ${g.title}`).join(' + ') : pickedText;
  const buyer = purchase?.buyer;
  const spinner = busy ? <Loader2 size={16} className="animate-spin" /> : null;

  if (purchase?.status === 'bought') {
    return (
      <div className="rounded-[18px] bg-success/12 p-4" data-purchase="bought">
        <div className="text-[16px] font-semibold text-success">🎉 Подарок куплен</div>
        <p className="mt-0.5 text-[14px] leading-snug">
          {gifts}
          {buyer && !purchase.is_me && <span className="text-hint"> · купил(а) {buyer.first_name}</span>}
        </p>
        {purchase.is_me && (
          <button
            onClick={() => onAction('reopen')}
            disabled={busy}
            className="mt-2 text-[13px] font-medium text-link"
          >
            Ошибка? Вернуть сбор
          </button>
        )}
      </div>
    );
  }

  if (purchase?.status === 'buying') {
    return (
      <div className="rounded-[18px] bg-card p-4" data-purchase="buying">
        <div className="flex items-center gap-3">
          {buyer && <Avatar user={buyer} size={40} />}
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold">
              {purchase.is_me ? 'Покупаете вы' : `Покупает ${buyer?.first_name ?? 'участник сбора'}`}
            </div>
            <div className="truncate text-[13px] text-hint">{gifts}</div>
          </div>
        </div>
        {purchase.is_me ? (
          <>
            <p className="mt-2 text-[13px] leading-snug text-hint">
              Соберите переводы от участников в чате сбора и отметьте, когда подарок куплен
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => onAction('bought')}
                disabled={busy}
                data-purchase-bought
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[12px] bg-success text-[15px] font-semibold text-white"
              >
                {spinner ?? '✅ Куплено'}
              </button>
              <button
                onClick={() => onAction('release')}
                disabled={busy}
                className="h-11 rounded-[12px] bg-fill px-4 text-[15px] font-semibold text-destructive"
              >
                Отказаться
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[14px] leading-snug">
              Переведите свою часть {buyer?.first_name ?? 'покупателю'} — договоритесь в чате сбора
            </p>
            {buyer?.username && (
              <button
                onClick={() => openTelegramLink(`https://t.me/${buyer.username}`)}
                className="mt-2 text-[14px] font-medium text-link"
              >
                Написать {buyer.first_name}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-[18px] bg-card p-4" data-purchase="none">
      <div className="text-[16px] font-semibold">Кто покупает?</div>
      <p className="mt-0.5 text-[13px] leading-snug text-hint">
        Возьмите покупку на себя — остальные увидят, кому переводить. Сейчас по голосам: {pickedText}
      </p>
      <button
        onClick={() => onAction('take')}
        disabled={busy}
        data-purchase-take
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text"
      >
        {spinner ?? '🛍 Я покупаю'}
      </button>
    </div>
  );
}

/** Дата рождения друга в шапке: «🎂 26 октября · через 5 дней» */
function FriendBirthday({ birthday }: { birthday: string | null }) {
  const b = parseBirthday(birthday);
  if (!b) return <div className="mt-2 text-[14px] text-hint">🎂 Дату рождения пока не указали</div>;
  const days = daysUntilBirthday(b);
  return (
    <div
      className={`mt-2 rounded-full px-3 py-1 text-[14px] font-semibold ${days === 0 ? 'bg-success/15 text-success' : 'bg-gold/20'}`}
      data-friend-birthday
    >
      {days === 0 ? '🎉 Сегодня день рождения!' : `🎂 ${formatBirthday(b)} · ${inDaysText(days)}`}
    </div>
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

/** Кто скидывается вместе со мной и их чат в Telegram. Видят только участники сбора. */
function PoolTeam({
  supporters,
  chat,
  busy,
  creating,
  onSaveChat,
  onCreateChat,
}: {
  supporters: Supporter[];
  chat: FriendPayload['pool_chat'];
  busy: boolean;
  creating: boolean;
  onSaveChat: (link: string) => Promise<boolean>;
  onCreateChat: () => void;
}) {
  // «Изменить» относится к конкретной ссылке: как только чат сменился
  // (бот привязал новый), карточка сама возвращается к кнопке «Открыть»
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const editing = !!chat && editingLink === chat.link;
  const setEditing = (on: boolean) => setEditingLink(on && chat ? chat.link : null);
  const [manual, setManual] = useState(false);
  const [link, setLink] = useState('');
  const [canPm, setCanPm] = useState(allowsWriteToPm);
  const usernames = supporters.filter((s) => !s.is_me && s.username).map((s) => `@${s.username}`);
  const showSetup = !chat || editing;

  const save = async (value: string) => {
    if (await onSaveChat(value)) {
      setEditing(false);
      setManual(false);
      setLink('');
    }
  };

  const copy = async () => {
    if (await copyText(usernames.join(' '))) toast(`Скопировано: ${usernames.join(' ')}`, 'success');
    else toast('Не получилось скопировать', 'error');
  };

  const allowPm = async () => {
    const granted = await requestWriteAccess();
    setCanPm(granted);
    toast(granted ? 'Готово — бот пришлёт приглашение, когда появится чат сбора' : 'Без разрешения бот не сможет написать вам', granted ? 'success' : 'info');
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
        {!showSetup && chat ? (
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
                {chat.managed
                  ? '🔒 Пускает только участников сбора'
                  : chat.set_by
                    ? `Чат добавил(а) ${chat.set_by.first_name}`
                    : 'Чат участников сбора'}
              </span>
              <button onClick={() => setEditing(true)} className="shrink-0 text-link">
                Изменить
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[15px] font-semibold">Чат, чтобы договориться о покупке</div>
            <p className="mt-0.5 text-[13px] leading-snug text-hint">
              Telegram предложит создать новый чат или выбрать существующий. Бот пришлёт приглашение всем участникам
              сбора и будет пускать в чат только их
            </p>
            <button
              onClick={onCreateChat}
              disabled={creating}
              data-create-pool-chat
              className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-accent-text transition active:scale-[0.98] disabled:opacity-60"
            >
              {creating ? <Loader2 size={18} className="animate-spin" /> : '💬 Создать чат сбора'}
            </button>

            {manual ? (
              <>
                <form
                  className="mt-3 flex gap-2"
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
                    className="flex h-11 shrink-0 items-center rounded-[12px] bg-fill px-4 text-[15px] font-semibold text-link disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : 'Сохранить'}
                  </button>
                </form>
                {usernames.length > 0 && (
                  <button onClick={() => void copy()} className="mt-2 text-[13px] font-semibold text-link">
                    Скопировать {usernames.length === 1 ? 'username участника' : 'username участников'}
                  </button>
                )}
              </>
            ) : null}

            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              {!manual && (
                <button onClick={() => setManual(true)} className="text-link" data-manual-chat>
                  Уже есть чат? Вставить ссылку
                </button>
              )}
              {chat && editing && (
                <>
                  <button onClick={() => void save('')} className="text-destructive">
                    Отвязать чат
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setManual(false);
                    }}
                    className="text-hint"
                  >
                    Отмена
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {!canPm && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-[12px] bg-fill px-3 py-2.5">
            <span className="text-[13px] leading-snug">🔔 Разрешите боту писать вам — так придёт приглашение в чат</span>
            <button onClick={() => void allowPm()} className="shrink-0 text-[13px] font-semibold text-link">
              Разрешить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
