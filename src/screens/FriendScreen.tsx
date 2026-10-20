import { motion, useIsPresent } from 'framer-motion';
import { Check, ExternalLink, Loader2, Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { FriendGift, FriendPayload, Member } from '../api/types';
import { Avatar } from '../components/Avatar';
import { Confetti } from '../components/Confetti';
import { GiftThumb } from '../components/GiftThumb';
import { Lightbox } from '../components/Lightbox';
import { ProgressBar, ProgressPills } from '../components/ProgressBar';
import { toast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { Layer, useBackButton, useMainButton } from '../telegram/buttons';
import { confirmAction, haptic, hapticNotification, hapticSelection, openLink } from '../telegram/webapp';
import {
  currencySymbol,
  formatMoney,
  formatNumber,
  formatShort,
  fullName,
  linkHost,
  parseAmount,
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
  const [votingId, setVotingId] = useState<string | null>(null);
  const [burst, setBurst] = useState(0);
  const [photo, setPhoto] = useState<{ src: string; caption: string } | null>(null);

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
  usePolling(load, POLL_MS, isPresent && !saving && votingId === null);

  const saved = data?.my_pledge ?? 0;
  const changed = dirty && draft !== saved;
  const gifts = data?.gifts ?? [];
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
    if (await confirmAction('Выйти из сбора? Ваш голос тоже отменится.')) void savePledge(0);
  };

  const vote = async (gift: FriendGift) => {
    if (!data || votingId) return;
    const target = data.my_vote === gift.id ? null : gift.id;
    haptic('medium');
    setVotingId(gift.id);
    const s = ++seq.current;
    try {
      apply(s, await api.vote(roomId, friendId, target));
      onChanged();
      if (target) toast(`Ваш голос — за ${gift.emoji} ${gift.title}. Голоса анонимны`, 'success');
    } catch (err) {
      if (!handleError(err)) toast(errorMessage(err), 'error');
    } finally {
      setVotingId(null);
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
  const decidedIndex = data?.decided_gift_id ? gifts.findIndex((g) => g.id === data.decided_gift_id) : -1;
  const decided = decidedIndex >= 0 ? gifts[decidedIndex] : null;

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
              {data ? pluralize(gifts.length, ['подарок', 'подарка', 'подарков']) : 'вишлист'}
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
            {gifts.length > 0 && (
              <div className="rounded-[18px] bg-card p-4" data-summary>
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
                <div className="mt-3 flex items-start gap-2 text-[13px] leading-snug text-hint">
                  <Lock size={14} className="mt-[1px] shrink-0" />
                  <span>Суммы и участники сбора скрыты — видно только, на что хватает</span>
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
                <input
                  id="pledge"
                  value={draft ? formatNumber(draft) : ''}
                  onChange={(e) => onDraft(parseAmount(e.target.value))}
                  placeholder="0"
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  autoComplete="off"
                  className="tabular h-14 w-full bg-transparent text-[26px] font-bold outline-none placeholder:text-hint/60"
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

            {/* Подарки */}
            <section>
              <div className="mb-2 flex items-end justify-between px-1">
                <h2 className="text-[13px] font-semibold tracking-wide text-section uppercase">Вишлист</h2>
                <span className="text-[13px] text-hint">по цене</span>
              </div>

              {decided && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 rounded-[16px] bg-gold/20 px-4 py-3 text-[15px] leading-snug"
                  data-decision
                >
                  🎉 <b>Все участники сбора проголосовали</b> — покупаем {decided.emoji} {decided.title}
                  {views[decidedIndex].funded ? '' : `. Пока собрано ${views[decidedIndex].pct}%`}
                </motion.div>
              )}
              {!isSupporter && gifts.length > 0 && (
                <div className="mb-3 rounded-[16px] bg-accent/10 px-4 py-3 text-[14px] leading-snug text-accent">
                  Укажите сумму — и сможете голосовать за подарок, который купите вместе
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
                      myVote={data.my_vote}
                      canVote={isSupporter}
                      voting={votingId === g.id}
                      disabled={votingId !== null}
                      onVote={() => void vote(g)}
                      onOpenPhoto={(src) => setPhoto({ src, caption: `${g.title} · ${formatMoney(g.price)}` })}
                    />
                  );
                  return i === fundedCount && i > 0 ? [<BudgetLine key="budget-line" />, card] : [card];
                })}
                {gifts.length === 0 && (
                  <div className="rounded-[18px] bg-card p-6 text-center text-[15px] text-hint">
                    В вишлисте пока пусто
                  </div>
                )}
              </div>
            </section>
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
  myVote,
  canVote,
  voting,
  disabled,
  onVote,
  onOpenPhoto,
}: {
  gift: FriendGift;
  view: ReturnType<typeof giftView>;
  fundedByDraft: boolean;
  myVote: string | null;
  canVote: boolean;
  voting: boolean;
  disabled: boolean;
  onVote: () => void;
  onOpenPhoto: (src: string) => void;
}) {
  const voted = myVote === gift.id;
  const votePct = gift.vote_pct ?? 0;

  return (
    <motion.div
      layout
      transition={layoutSpring}
      className={`rounded-[18px] bg-card p-4 ${gift.is_leader ? 'ring-2 ring-gold' : ''}`}
      data-gift={gift.title}
    >
      <div className="flex gap-3">
        <GiftThumb gift={gift} size={60} radius={14} onOpen={onOpenPhoto} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[16px] leading-snug font-semibold">{gift.title}</div>
            {gift.is_leader && (
              <span className="shrink-0 rounded-full bg-gold px-2 py-0.5 text-[12px] font-bold text-[#3b2600]">
                🏆 Лидер
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[14px]">
            <span className="tabular font-semibold">{formatMoney(gift.price)}</span>
            {gift.link && (
              <button onClick={() => openLink(gift.link!)} className="flex items-center gap-1 text-link">
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
                <span className="tabular">голосов {votePct}%</span>
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
              {voting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : voted ? (
                <>
                  <Check size={16} strokeWidth={3} /> Мой выбор
                </>
              ) : (
                'Голосовать'
              )}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
