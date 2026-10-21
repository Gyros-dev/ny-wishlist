import { AnimatePresence, motion } from 'framer-motion';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, isBackendConfigured } from './api/client';
import type { Bootstrap, Gift, Member, Occasion, Room, RoomPreview } from './api/types';
import { BirthdaySheet } from './components/BirthdaySheet';
import { Toaster, toast } from './components/Toast';
import { usePolling } from './hooks/usePolling';
import { FriendScreen } from './screens/FriendScreen';
import { GiftEditor } from './screens/GiftEditor';
import { HomeScreen, HomeSkeleton, type HomeTab, type RoomBootstrap } from './screens/HomeScreen';
import { CreateRoomSheet, JoinScreen, Onboarding, RoomsSheet } from './screens/RoomScreens';
import { Layer, useBackButton } from './telegram/buttons';
import { closeApp, confirmAction, isTelegram, startParam } from './telegram/webapp';
import { setCurrency } from './utils/format';
import { appLink, inviteCodeFromStartParam, inviteLink, shareToTelegram } from './utils/share';

export default function App() {
  if (!isBackendConfigured) {
    return (
      <Notice emoji="🛠️" title="Нет подключения к базе">
        Задайте VITE_SUPABASE_URL и VITE_SUPABASE_KEY при сборке — см. README
      </Notice>
    );
  }
  if (!isTelegram) {
    const link = appLink();
    return (
      <Notice emoji="🎁" title="Вишлист живёт в Telegram">
        Откройте мини-приложение через бота — так мы узнаем, кто вы, без паролей и регистрации
        {link && (
          <a href={link} className="mt-5 block rounded-[14px] bg-accent py-3.5 text-[16px] font-semibold text-accent-text">
            Открыть в Telegram
          </a>
        )}
      </Notice>
    );
  }
  return <WishlistApp />;
}

interface OpenFriend {
  id: number;
  preview: Member | null;
}

function WishlistApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [fatal, setFatal] = useState<Error | null>(null);
  const [invite, setInvite] = useState<{ code: string; preview: RoomPreview } | null>(null);
  const [joining, setJoining] = useState(false);
  const [tab, setTab] = useState<HomeTab>('mine');
  const [friend, setFriend] = useState<OpenFriend | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; gift: Gift | null }>({ open: false, gift: null });
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [birthdayOpen, setBirthdayOpen] = useState(false);
  const bootRef = useRef<Bootstrap | null>(null);

  /** roomId — какую компанию открыть; null — последнюю открытую. */
  const load = useCallback(async (roomId: string | null) => {
    try {
      const next = await api.bootstrap(roomId);
      const roomChanged = next.room?.id !== bootRef.current?.room?.id;
      bootRef.current = next;
      setBoot(next);
      setFatal(null);
      if (roomChanged) {
        // В другой компании — другие люди: закрываем открытого друга.
        // Новичка встречаем на своём вишлисте, остальных — на участниках.
        setFriend(null);
        setTab(next.gifts.length > 0 ? 'friends' : 'mine');
      }
      return next;
    } catch (err) {
      if (!bootRef.current || (err instanceof ApiError && err.isAuth)) setFatal(err as Error);
      return null;
    }
  }, []);

  const refresh = useCallback(() => load(bootRef.current?.room?.id ?? null), [load]);

  useEffect(() => {
    void (async () => {
      const code = inviteCodeFromStartParam(startParam);
      let roomId: string | null = null;
      if (code) {
        try {
          const preview = await api.roomPreview(code);
          if (preview.is_member) roomId = preview.id;
          else setInvite({ code, preview });
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }
      await load(roomId);
    })();
  }, [load]);

  // Список участников тоже живой: новые вишлисты и прогресс подтягиваются сами.
  // Пока идёт набор в Тайного Санту — чаще: видно, кто записался, а пара
  // появляется сразу после жеребьёвки.
  usePolling(
    refresh,
    boot?.santa?.status === 'open' ? 5000 : 15000,
    !!boot?.room && !friend && !editor.open && !roomsOpen && !createOpen && !birthdayOpen && !invite,
  );

  const closeEditor = useCallback(() => setEditor((e) => ({ ...e, open: false })), []);
  const closeRooms = useCallback(() => setRoomsOpen(false), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeBirthday = useCallback(() => setBirthdayOpen(false), []);
  useBackButton(
    Layer.sheet,
    editor.open
      ? closeEditor
      : createOpen
        ? closeCreate
        : roomsOpen
          ? closeRooms
          : birthdayOpen
            ? closeBirthday
            : null,
  );

  const room = boot?.room ?? null;
  // Валюта открытой компании — для всех сумм на экранах
  if (room) setCurrency(room.currency);

  const join = async () => {
    if (!invite) return;
    setJoining(true);
    try {
      const joined = await api.joinRoom(invite.code);
      setInvite(null);
      await load(joined.id);
      toast(`Вы в компании «${joined.name}»!`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setJoining(false);
    }
  };

  const shareInvite = () => {
    if (!room) return;
    const link = inviteLink(room.invite_code);
    if (!link) {
      toast('Чтобы делиться приглашением, задайте VITE_BOT_USERNAME', 'error');
      return;
    }
    shareToTelegram(
      link,
      room.occasion === 'birthdays'
        ? `Залетай в «${room.name}» — собираем вишлисты на дни рождения 🎂`
        : `Залетай в «${room.name}» — собираем вишлисты на Новый год 🎁`,
    );
  };

  const onRoomCreated = async (created: Room) => {
    setCreateOpen(false);
    setRoomsOpen(false);
    await load(created.id);
    setTab('friends');
    toast('Компания создана — пригласите друзей', 'success');
  };

  const switchRoom = (roomId: string) => {
    setRoomsOpen(false);
    void load(roomId);
  };

  const leaveRoom = async () => {
    if (!room) return;
    const ok = await confirmAction(
      `Выйти из «${room.name}»? Ваш вишлист, взносы и голоса в этой компании удалятся.`,
    );
    if (!ok) return;
    try {
      await api.leaveRoom(room.id);
      setRoomsOpen(false);
      await load(null);
      toast(`Вы вышли из «${room.name}»`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const onSanta = async (action: 'open' | 'join' | 'leave' | 'draw' | 'cancel', budget?: number | null) => {
    if (!room) return;
    try {
      const santa = await api.santa(room.id, action, budget ?? null);
      setBoot((b) => b && { ...b, santa });
      const messages = {
        open: 'Набор открыт — бот позвал всех участников',
        join: 'Вы участвуете в Тайном Санте',
        leave: 'Вы больше не участвуете',
        draw: 'Жеребьёвка прошла — каждому пришла его пара',
        cancel: 'Тайный Санта отменён',
      } as const;
      toast(messages[action], 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const saveBirthday = async (birthday: { month: number; day: number } | null) => {
    try {
      const me = await api.setBirthday(birthday);
      setBoot((b) => b && { ...b, me: { ...b.me, birthday: me.birthday ?? null } });
      setBirthdayOpen(false);
      toast(birthday ? 'Готово — друзья увидят дату' : 'Дата убрана', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const changeOccasion = async (occasion: Occasion) => {
    if (!room || occasion === room.occasion) return;
    const ok = await confirmAction(
      occasion === 'birthdays'
        ? 'Сделать компанию для дней рождения? У каждого будет свой праздник, бот напомнит о нём заранее, а через неделю после дня рождения сбор закроется. Тайный Санта скроется.'
        : 'Сделать компанию новогодней? Сборы перестанут закрываться после дней рождения, вернётся Тайный Санта.',
    );
    if (!ok) return;
    try {
      await api.setRoomOccasion(room.id, occasion);
      setRoomsOpen(false);
      await load(room.id);
      toast(occasion === 'birthdays' ? 'Теперь это компания дней рождения 🎂' : 'Теперь это новогодняя компания 🎄', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const onGiftSaved = (gift: Gift) => {
    const isNew = !editor.gift;
    closeEditor();
    setBoot((b) =>
      b && {
        ...b,
        gifts: isNew ? [...b.gifts, gift] : b.gifts.map((g) => (g.id === gift.id ? gift : g)),
      },
    );
    toast(isNew ? `${gift.emoji} ${gift.title} — в вишлисте` : 'Сохранено', 'success');
    void refresh();
  };

  const onGiftDeleted = (giftId: string) => {
    closeEditor();
    setBoot((b) => b && { ...b, gifts: b.gifts.filter((g) => g.id !== giftId) });
    toast('Подарок удалён');
    void refresh();
  };

  if (fatal && !boot) {
    const auth = fatal instanceof ApiError && fatal.isAuth;
    return (
      <Notice emoji={auth ? '🔄' : '😕'} title={auth ? 'Нужно перезапустить' : 'Не удалось загрузить'}>
        {errorMessage(fatal)}
        <button
          onClick={() => (auth ? closeApp() : void load(null))}
          className="mt-5 block w-full rounded-[14px] bg-accent py-3.5 text-[16px] font-semibold text-accent-text"
        >
          {auth ? 'Закрыть' : 'Повторить'}
        </button>
      </Notice>
    );
  }

  if (!boot) return <HomeSkeleton />;

  return (
    <>
      {invite ? (
        <JoinScreen preview={invite.preview} joining={joining} onJoin={() => void join()} onSkip={() => setInvite(null)} />
      ) : !room ? (
        <Onboarding me={boot.me} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <motion.div
            animate={{ x: friend ? '-22%' : 0, opacity: friend ? 0.6 : 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 38 }}
            className="fixed inset-0"
          >
            <HomeScreen
              boot={boot as RoomBootstrap}
              tab={tab}
              onTab={setTab}
              onAddGift={() => setEditor({ open: true, gift: null })}
              onEditGift={(gift) => setEditor({ open: true, gift })}
              onOpenFriend={(m) => setFriend({ id: m.id, preview: m })}
              onOpenRooms={() => setRoomsOpen(true)}
              onInvite={shareInvite}
              onSanta={onSanta}
              onEditBirthday={() => setBirthdayOpen(true)}
            />
          </motion.div>

          <AnimatePresence>
            {friend && (
              <motion.div
                key={`${room.id}:${friend.id}`}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', stiffness: 360, damping: 38 }}
                className="fixed inset-0 z-10 shadow-[-8px_0_24px_rgba(0,0,0,0.12)]"
              >
                <FriendScreen
                  roomId={room.id}
                  occasion={room.occasion}
                  friendId={friend.id}
                  preview={friend.preview}
                  onBack={() => {
                    setFriend(null);
                    void refresh();
                  }}
                  onChanged={() => void refresh()}
                  onForbidden={() => {
                    setFriend(null);
                    void load(null);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <GiftEditor
            roomId={room.id}
            open={editor.open}
            gift={editor.gift}
            onClose={closeEditor}
            onSaved={onGiftSaved}
            onDeleted={onGiftDeleted}
          />
          <RoomsSheet
            open={roomsOpen}
            boot={boot as RoomBootstrap}
            onClose={closeRooms}
            onSwitch={switchRoom}
            onInvite={shareInvite}
            onCreate={() => {
              setRoomsOpen(false);
              setCreateOpen(true);
            }}
            onLeave={() => void leaveRoom()}
            onOccasion={(occasion) => void changeOccasion(occasion)}
          />
          <BirthdaySheet
            open={birthdayOpen}
            value={boot.me.birthday ?? null}
            onClose={closeBirthday}
            onSave={saveBirthday}
          />
        </>
      )}
      <CreateRoomSheet open={createOpen} onClose={closeCreate} onCreated={(r) => void onRoomCreated(r)} />
      <Toaster />
    </>
  );
}

function Notice({ emoji, title, children }: { emoji: string; title: string; children: ReactNode }) {
  return (
    <div className="screen flex items-center justify-center px-8">
      <div className="w-full max-w-sm text-center">
        <div className="bob text-[64px]">{emoji}</div>
        <h1 className="mt-3 text-[22px] font-bold">{title}</h1>
        <div className="mt-2 text-[15px] leading-snug text-hint">{children}</div>
      </div>
    </div>
  );
}
