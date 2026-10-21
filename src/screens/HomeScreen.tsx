import { BellRing, ChevronRight, ExternalLink, UserPlus, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { Bootstrap, Gift, Member, Person, Room, User } from '../api/types';
import { Avatar } from '../components/Avatar';
import { GiftThumb } from '../components/GiftThumb';
import { Hero, type NextBirthday } from '../components/Hero';
import { ProgressPills } from '../components/ProgressBar';
import { SantaCard } from '../components/SantaCard';
import { Segmented } from '../components/Segmented';
import { toast } from '../components/Toast';
import { Layer, useMainButton } from '../telegram/buttons';
import { dismissBotMessages, enableBotMessages, onBotMessagesChange, shouldOfferBotMessages } from '../telegram/webapp';
import { daysUntilBirthday, formatBirthday, inDaysText, parseBirthday } from '../utils/birthday';
import { currencySymbol, formatMoney, fullName, linkHost, pluralize } from '../utils/format';

export type HomeTab = 'mine' | 'friends';

const MAX_GIFTS = 30;

export type RoomBootstrap = Bootstrap & { room: Room };

interface Props {
  boot: RoomBootstrap;
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  onAddGift: () => void;
  onEditGift: (gift: Gift) => void;
  onOpenFriend: (member: Member) => void;
  onOpenRooms: () => void;
  onInvite: () => void;
  onSanta: (action: 'open' | 'join' | 'leave' | 'draw' | 'cancel', budget?: number | null) => Promise<void>;
  onEditBirthday: () => void;
}

/** Дней до дня рождения; null — дата не указана */
function birthdayIn(person: Person): number | null {
  const b = parseBirthday(person.birthday);
  return b ? daysUntilBirthday(b) : null;
}

/** Ближайший день рождения в компании — для шапки */
function nearestBirthday(me: Person, members: Member[]): NextBirthday | null {
  let best: NextBirthday | null = null;
  for (const person of [me, ...members]) {
    const b = parseBirthday(person.birthday);
    if (!b) continue;
    const days = daysUntilBirthday(b);
    if (!best || days < best.days) {
      best = { who: person.id === me.id ? 'ваш' : person.first_name, date: formatBirthday(b), days };
    }
  }
  return best;
}

export function HomeScreen({
  boot,
  tab,
  onTab,
  onAddGift,
  onEditGift,
  onOpenFriend,
  onOpenRooms,
  onInvite,
  onSanta,
  onEditBirthday,
}: Props) {
  const { room } = boot;
  const birthdays = room.occasion === 'birthdays';
  const withGifts = boot.members.filter((m) => m.gift_count > 0);

  useMainButton(
    Layer.home,
    tab === 'mine'
      ? boot.gifts.length < MAX_GIFTS
        ? { text: boot.gifts.length ? 'Добавить подарок' : 'Добавить первый подарок', onClick: onAddGift, shine: !boot.gifts.length }
        : null
      : { text: 'Пригласить в компанию', onClick: onInvite, shine: boot.members.length === 0 },
  );

  return (
    <div className="screen" data-screen="home">
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-3 pb-10">
        <Hero
          title={room.name}
          subtitle={`${pluralize(room.member_count, ['участник', 'участника', 'участников'])} · цены в ${currencySymbol()}`}
          onTitleClick={onOpenRooms}
          occasion={room.occasion}
          nextBirthday={birthdays ? nearestBirthday(boot.me, boot.members) : null}
        />
        <BotMessagesBanner birthdays={birthdays} />
        <Segmented<HomeTab>
          value={tab}
          onChange={onTab}
          options={[
            { value: 'mine', label: 'Мой вишлист', badge: boot.gifts.length },
            { value: 'friends', label: 'Участники', badge: withGifts.length },
          ]}
        />

        {tab === 'mine' ? (
          <>
            {birthdays && <MyBirthdayCard birthday={boot.me.birthday ?? null} onEdit={onEditBirthday} />}
            <MyWishlist boot={boot} onEditGift={onEditGift} onInvite={onInvite} />
          </>
        ) : (
          <>
            {!birthdays && (
              <SantaCard
                room={room}
                santa={boot.santa}
                onAction={onSanta}
                onOpenReceiver={(user: User) => {
                  const member = boot.members.find((m) => m.id === user.id);
                  if (member) onOpenFriend(member);
                }}
              />
            )}
            <MembersList members={boot.members} birthdays={birthdays} onOpenFriend={onOpenFriend} onInvite={onInvite} />
          </>
        )}
      </div>
    </div>
  );
}

/** Один раз предложить разрешить боту писать — иначе напоминания не дойдут */
function BotMessagesBanner({ birthdays }: { birthdays: boolean }) {
  const [show, setShow] = useState(shouldOfferBotMessages);
  useEffect(() => onBotMessagesChange(() => setShow(shouldOfferBotMessages())), []);
  if (!show) return null;

  const allow = async () => {
    const granted = await enableBotMessages();
    toast(
      granted ? 'Готово — бот будет присылать напоминания' : 'Без разрешения бот не сможет написать вам',
      granted ? 'success' : 'info',
    );
  };

  return (
    <div className="flex items-start gap-3 rounded-[16px] bg-accent/10 py-3 pr-2 pl-4" data-bot-messages>
      <BellRing size={22} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">Включите напоминания</div>
        <div className="text-[13px] leading-snug text-hint">
          Бот напишет {birthdays ? 'перед днями рождения' : 'перед Новым годом'} и когда кто-то покупает подарок
        </div>
        <button
          onClick={() => void allow()}
          data-bot-messages-allow
          className="mt-2 rounded-full bg-accent px-4 py-1.5 text-[14px] font-semibold text-accent-text transition active:scale-95"
        >
          Разрешить
        </button>
      </div>
      <button onClick={dismissBotMessages} aria-label="Не сейчас" className="shrink-0 p-1 text-hint">
        <X size={18} />
      </button>
    </div>
  );
}

function GiftRows({ gifts, onEditGift, dimmed = false }: { gifts: Gift[]; onEditGift: (g: Gift) => void; dimmed?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-[16px] bg-card ${dimmed ? 'opacity-70' : ''}`}>
      {gifts.map((g, i) => (
        <button
          key={g.id}
          onClick={() => onEditGift(g)}
          className="flex w-full items-center gap-3 pl-4 text-left active:bg-fill"
          data-my-gift={g.title}
        >
          <span className="my-2.5">
            <GiftThumb gift={g} size={48} radius={12} />
          </span>
          <span
            className={`flex min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pr-4 ${i ? 'border-t border-separator' : ''}`}
          >
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[16px] leading-snug">
                {g.must_have && <span title="Очень хочу">⭐ </span>}
                {g.title}
              </span>
              {g.note && <span className="mt-0.5 line-clamp-1 block text-[13px] text-hint">{g.note}</span>}
              {g.link && (
                <span className="mt-0.5 flex items-center gap-1 text-[13px] text-hint">
                  <ExternalLink size={12} /> {linkHost(g.link)}
                </span>
              )}
            </span>
            <span className="tabular shrink-0 text-[15px] font-semibold">{formatMoney(g.price)}</span>
            <ChevronRight size={18} className="shrink-0 text-hint/70" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Своя дата рождения в компании дней рождения: напомнить указать или показать, сколько осталось */
function MyBirthdayCard({ birthday, onEdit }: { birthday: string | null; onEdit: () => void }) {
  const b = parseBirthday(birthday);
  if (!b) {
    return (
      <button
        onClick={onEdit}
        data-my-birthday="unset"
        className="flex w-full items-center gap-3 rounded-[16px] bg-gold/15 px-4 py-3.5 text-left ring-1 ring-gold/40 transition active:scale-[0.985]"
      >
        <span className="text-[28px] leading-none">🎂</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold">Когда ваш день рождения?</span>
          <span className="block text-[13px] leading-snug text-hint">Друзья увидят дату и успеют скинуться на подарок</span>
        </span>
        <span className="shrink-0 text-[15px] font-semibold text-link">Указать</span>
      </button>
    );
  }
  const days = daysUntilBirthday(b);
  return (
    <button
      onClick={onEdit}
      data-my-birthday={birthday}
      className="flex w-full items-center gap-3 rounded-[16px] bg-card px-4 py-3 text-left transition active:scale-[0.985]"
    >
      <span className="text-[26px] leading-none">{days === 0 ? '🎉' : '🎂'}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-hint">Ваш день рождения</span>
        <span className="block text-[16px] font-semibold">
          {days === 0 ? 'Сегодня! С днём рождения 🎉' : `${formatBirthday(b)} · ${inDaysText(days)}`}
        </span>
      </span>
      <span className="shrink-0 text-[15px] text-link">Изменить</span>
    </button>
  );
}

function MyWishlist({ boot, onEditGift, onInvite }: { boot: RoomBootstrap; onEditGift: (g: Gift) => void; onInvite: () => void }) {
  const active = boot.gifts.filter((g) => !g.received);
  const received = boot.gifts.filter((g) => g.received);
  if (boot.gifts.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 pt-8 pb-4 text-center">
        <div className="bob text-[64px]">🎁</div>
        <h2 className="mt-3 text-[20px] font-bold">Соберите свой вишлист</h2>
        <p className="mt-1.5 text-[15px] leading-snug text-hint">
          Добавьте подарки, цены, фото и ссылки. Участники «{boot.room.name}» скинутся вместе и выберут, что купить
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-start gap-3 rounded-[16px] bg-card px-4 py-3.5">
        <span className="text-[22px] leading-none">{boot.has_supporters ? '🤫' : '🔒'}</span>
        <p className="text-[14px] leading-snug">
          {boot.has_supporters ? (
            <>
              <b>Друзья уже скидываются вам на подарок.</b> Кто, сколько и что выберут — секрет до{' '}
              {boot.room.occasion === 'birthdays' ? 'дня рождения' : 'Нового года'}
            </>
          ) : (
            <>Ваш вишлист видят только участники «{boot.room.name}». Что и сколько соберут — останется сюрпризом</>
          )}
        </p>
      </div>

      {active.length > 0 && (
        <div>
          <SectionTitle>Мои подарки</SectionTitle>
          <GiftRows gifts={active} onEditGift={onEditGift} />
        </div>
      )}

      {received.length > 0 && (
        <div>
          <SectionTitle>🎉 Мне это подарили</SectionTitle>
          <GiftRows gifts={received} onEditGift={onEditGift} dimmed />
        </div>
      )}

      <button
        onClick={onInvite}
        className="flex w-full items-center justify-center gap-2 rounded-[16px] bg-card py-3.5 text-[16px] font-medium text-link"
      >
        <UserPlus size={18} /> Позвать друзей в компанию
      </button>
    </>
  );
}

function MembersList({
  members,
  birthdays,
  onOpenFriend,
  onInvite,
}: {
  members: Member[];
  birthdays: boolean;
  onOpenFriend: (m: Member) => void;
  onInvite: () => void;
}) {
  // в компании дней рождения — по ближайшей дате, без даты — в конце
  const sorted = birthdays
    ? [...members].sort((a, b) => (birthdayIn(a) ?? 1000) - (birthdayIn(b) ?? 1000))
    : members;
  const withGifts = sorted.filter((m) => m.gift_count > 0);
  const waiting = sorted.filter((m) => m.gift_count === 0);

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 pt-8 pb-4 text-center">
        <div className="bob text-[60px]">{birthdays ? '🎂' : '🎄'}</div>
        <h2 className="mt-3 text-[20px] font-bold">Пока вы здесь одни</h2>
        <p className="mt-1.5 text-[15px] leading-snug text-hint">
          Отправьте друзьям ссылку-приглашение — вишлисты компании увидят только те, кто по ней вступит
        </p>
        <button onClick={onInvite} className="mt-4 text-[16px] font-medium text-link">
          Пригласить
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {withGifts.length > 0 && (
        <SectionTitle>{birthdays ? 'Ближайшие дни рождения' : 'Кому собираем подарки'}</SectionTitle>
      )}
      {withGifts.map((m) => (
        <MemberCard key={m.id} member={m} birthdays={birthdays} onClick={() => onOpenFriend(m)} />
      ))}

      {waiting.length > 0 && (
        <div className="rounded-[18px] bg-card p-4">
          <div className="text-[13px] font-semibold tracking-wide text-section uppercase">Ещё собирают вишлист</div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
            {waiting.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <Avatar user={m} size={30} />
                <span className="text-[15px]">{m.first_name}</span>
                {birthdays && parseBirthday(m.birthday) && (
                  <span className="text-[13px] text-hint">🎂 {formatBirthday(parseBirthday(m.birthday)!)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** «🎂 26 октября · через 5 дней»; ближайшие — ярче, в сам день — праздник */
function BirthdayLine({ person }: { person: Person }) {
  const b = parseBirthday(person.birthday);
  if (!b) return <div className="text-[14px] text-hint">🎂 Дата не указана</div>;
  const days = daysUntilBirthday(b);
  if (days === 0) {
    return <div className="text-[14px] font-semibold text-success">🎉 Сегодня день рождения!</div>;
  }
  return (
    <div className={`text-[14px] ${days <= 14 ? 'font-semibold text-accent' : 'text-hint'}`} data-birthday-in={days}>
      🎂 {formatBirthday(b)} · {inDaysText(days)}
    </div>
  );
}

function MemberCard({ member: m, birthdays, onClick }: { member: Member; birthdays: boolean; onClick: () => void }) {
  const best = m.progress.reduce((max, p) => (p < 100 ? Math.max(max, p) : max), 0);
  return (
    <button
      onClick={onClick}
      data-friend={m.first_name}
      className="block w-full rounded-[18px] bg-card p-4 text-left transition active:scale-[0.985]"
    >
      <div className="flex items-center gap-3">
        <Avatar user={m} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold">{fullName(m)}</div>
          {birthdays && <BirthdayLine person={m} />}
          <div className="text-[14px] text-hint">
            {pluralize(m.gift_count, ['подарок', 'подарка', 'подарков'])} · от {formatMoney(m.min_price ?? 0)}
          </div>
        </div>
        <ChevronRight size={20} className="shrink-0 text-hint/70" />
      </div>

      <div className="mt-3.5">
        <ProgressPills progress={m.progress} />
      </div>
      <div className="mt-2 text-[14px] text-hint">
        {m.purchase_status === 'bought' ? (
          <b className="text-success">🎉 Подарок куплен — сбор закрыт</b>
        ) : m.pool_count === 0 ? (
          'Все подарки уже кто-то дарит сам'
        ) : m.together_count === m.pool_count ? (
          <b className="text-success">✓ Хватает на все подарки сразу — можно не скидываться</b>
        ) : m.together_next_missing !== null && (m.together_count > 0 || best > 0) ? (
          <>
            {m.together_count > 0 && (
              <>
                Хватает {m.together_count > 1 ? 'сразу ' : ''}на{' '}
                <b className="text-text">
                  {m.together_count} из {m.pool_count}
                </b>
                .{' '}
              </>
            )}
            {m.together_count > 0 ? 'Ещё на один' : 'До ближайшего'} не хватает{' '}
            <b className="tabular text-text">{formatMoney(m.together_next_missing)}</b>
          </>
        ) : (
          'Сбор ещё не начался — будьте первым'
        )}
        {m.reserved_count > 0 && m.pool_count > 0 && m.purchase_status !== 'bought' && (
          <> · ещё {m.reserved_count} дарят сами</>
        )}
      </div>

      {(m.my_pledge || m.picked.length > 0 || m.my_reserved_count > 0 || m.purchase_status === 'buying') && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.transfer_due && (
            <span className="tabular rounded-full bg-accent px-2.5 py-1 text-[13px] font-semibold text-accent-text" data-transfer-due>
              💸 Перевести {formatMoney(m.transfer_due.amount)} · покупает {m.transfer_due.buyer}
            </span>
          )}
          {m.purchase_status === 'buying' && (
            <span className="rounded-full bg-success/15 px-2.5 py-1 text-[13px] font-semibold text-success">
              🛍 Подарок уже покупают
            </span>
          )}
          {m.my_pledge ? (
            <span className="tabular rounded-full bg-accent/12 px-2.5 py-1 text-[13px] font-semibold text-accent">
              Ваш вклад · {formatMoney(m.my_pledge)}
            </span>
          ) : null}
          {m.my_reserved_count > 0 && (
            <span className="rounded-full bg-gold/20 px-2.5 py-1 text-[13px] font-semibold">
              🎁 Вы дарите сами · {m.my_reserved_count}
            </span>
          )}
          {m.picked.length > 0 && (
            <span className="max-w-full truncate rounded-full bg-gold/20 px-2.5 py-1 text-[13px] font-medium">
              🏆 {m.picked[0].emoji} {m.picked[0].title}
              {m.picked.length > 1 ? ` + ещё ${m.picked.length - 1}` : ''}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-section uppercase">{children}</h2>;
}

export function HomeSkeleton() {
  return (
    <div className="screen">
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-3">
        <div className="hero h-[124px] rounded-[22px] opacity-80" />
        <div className="shimmer h-[38px] rounded-[12px]" />
        <div className="shimmer h-[92px] rounded-[18px]" />
        <div className="shimmer h-[92px] rounded-[18px]" />
        <div className="shimmer h-[92px] rounded-[18px]" />
      </div>
    </div>
  );
}
