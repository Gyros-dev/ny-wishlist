import { ChevronRight, ExternalLink, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Bootstrap, Gift, Member, Room } from '../api/types';
import { Avatar } from '../components/Avatar';
import { GiftThumb } from '../components/GiftThumb';
import { Hero } from '../components/Hero';
import { ProgressPills } from '../components/ProgressBar';
import { Segmented } from '../components/Segmented';
import { Layer, useMainButton } from '../telegram/buttons';
import { currencySymbol, formatMoney, fullName, linkHost, plural, pluralize } from '../utils/format';

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
}

export function HomeScreen({ boot, tab, onTab, onAddGift, onEditGift, onOpenFriend, onOpenRooms, onInvite }: Props) {
  const { room } = boot;
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
        />
        <Segmented<HomeTab>
          value={tab}
          onChange={onTab}
          options={[
            { value: 'mine', label: 'Мой вишлист', badge: boot.gifts.length },
            { value: 'friends', label: 'Участники', badge: withGifts.length },
          ]}
        />

        {tab === 'mine' ? (
          <MyWishlist boot={boot} onEditGift={onEditGift} onInvite={onInvite} />
        ) : (
          <MembersList members={boot.members} onOpenFriend={onOpenFriend} onInvite={onInvite} />
        )}
      </div>
    </div>
  );
}

function MyWishlist({ boot, onEditGift, onInvite }: { boot: RoomBootstrap; onEditGift: (g: Gift) => void; onInvite: () => void }) {
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
              <b>Друзья уже скидываются вам на подарок.</b> Кто, сколько и что выберут — секрет до Нового года
            </>
          ) : (
            <>Ваш вишлист видят только участники «{boot.room.name}». Что и сколько соберут — останется сюрпризом</>
          )}
        </p>
      </div>

      <div>
        <SectionTitle>Мои подарки</SectionTitle>
        <div className="overflow-hidden rounded-[16px] bg-card">
          {boot.gifts.map((g, i) => (
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
                  <span className="line-clamp-2 text-[16px] leading-snug">{g.title}</span>
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
      </div>

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
  onOpenFriend,
  onInvite,
}: {
  members: Member[];
  onOpenFriend: (m: Member) => void;
  onInvite: () => void;
}) {
  const withGifts = members.filter((m) => m.gift_count > 0);
  const waiting = members.filter((m) => m.gift_count === 0);

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 pt-8 pb-4 text-center">
        <div className="bob text-[60px]">🎄</div>
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
      {withGifts.length > 0 && <SectionTitle>Кому собираем подарки</SectionTitle>}
      {withGifts.map((m) => (
        <MemberCard key={m.id} member={m} onClick={() => onOpenFriend(m)} />
      ))}

      {waiting.length > 0 && (
        <div className="rounded-[18px] bg-card p-4">
          <div className="text-[13px] font-semibold tracking-wide text-section uppercase">Ещё собирают вишлист</div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
            {waiting.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <Avatar user={m} size={30} />
                <span className="text-[15px]">{m.first_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MemberCard({ member: m, onClick }: { member: Member; onClick: () => void }) {
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
        {m.pool_count === 0 ? (
          'Все подарки уже кто-то дарит сам'
        ) : m.funded_count > 0 ? (
          <>
            Хватает на{' '}
            <b className="text-text">
              {m.funded_count} из {m.pool_count}
            </b>{' '}
            {plural(m.pool_count, ['подарка', 'подарков', 'подарков'])}
          </>
        ) : best > 0 ? (
          <>
            Ближайший подарок собран на <b className="tabular text-text">{best}%</b>
          </>
        ) : (
          'Сбор ещё не начался — будьте первым'
        )}
        {m.reserved_count > 0 && m.pool_count > 0 && (
          <> · ещё {m.reserved_count} дарят сами</>
        )}
      </div>

      {(m.my_pledge || m.leader || m.my_reserved_count > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
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
          {m.leader && (
            <span className="max-w-full truncate rounded-full bg-gold/20 px-2.5 py-1 text-[13px] font-medium">
              🏆 {m.leader.emoji} {m.leader.title}
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
