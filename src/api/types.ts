export interface User {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  photo_url: string | null;
}

/** new_year — общий Новый год с Тайным Сантой; birthdays — у каждого свой день рождения */
export type Occasion = 'new_year' | 'birthdays';

/** Человек с датой рождения: 'MM-DD' или null, если не указана */
export interface Person extends User {
  birthday?: string | null;
}

export interface Room {
  id: string;
  name: string;
  /** ISO 4217 */
  currency: string;
  occasion: Occasion;
  invite_code: string;
  is_owner: boolean;
  member_count: number;
}

export interface RoomPreview extends Omit<Room, 'invite_code'> {
  is_member: boolean;
  owner: User | null;
  members_preview: User[];
}

export interface Gift {
  id: string;
  title: string;
  price: number;
  emoji: string;
  link: string | null;
  /** размер, цвет, модель */
  note: string | null;
  /** «очень хочу» */
  must_have: boolean;
  /** владелец отметил «мне это подарили» */
  received: boolean;
  /** версия фото; null — фото нет */
  image_rev: number | null;
  created_at: string;
}

/** Участник компании глазами другого участника — без сумм и числа скинувшихся */
export interface Member extends Person {
  gift_count: number;
  min_price: number | null;
  /** сколько собрано на каждый подарок общего сбора, % по возрастанию цены */
  progress: number[];
  funded_count: number;
  /** подарков в общем сборе — без забронированных */
  pool_count: number;
  /** сколько подарков кто-то дарит сам — без имён */
  reserved_count: number;
  my_reserved_count: number;
  /** до ближайшего подарка из сбора не хватает; null — хватает на каждый */
  next_missing: number | null;
  /** на сколько подарков хватает сразу (самые недорогие вместе) */
  together_count: number;
  /** сколько не хватает, чтобы хватило ещё на один; null — хватает на все сразу */
  together_next_missing: number | null;
  purchase_status: 'buying' | 'bought' | null;
  my_pledge: number | null;
  /** итоговый набор по голосам — что покупаем */
  picked: { id: string; emoji: string; title: string }[];
}

export interface Bootstrap {
  me: Person;
  rooms: Room[];
  /** открытая компания; null — компаний пока нет */
  room: Room | null;
  gifts: Gift[];
  /** скидывается ли мне хоть кто-то — без сумм и числа людей */
  has_supporters: boolean;
  members: Member[];
  santa: SantaState | null;
}

export interface SantaState {
  status: 'open' | 'drawn';
  budget: number | null;
  participants: User[];
  joined: boolean;
  /** кому дарю я — видно только мне */
  receiver: User | null;
}

export interface FriendGift extends Gift {
  /** собрано от цены вместе с моим взносом, % */
  pct: number;
  /** собрано без моего взноса, % — для предпросмотра суммы */
  others_pct: number;
  funded: boolean;
  /** сколько ещё не хватает с моим взносом и без него */
  missing: number;
  others_missing: number;
  /**
   * Сколько не хватает, чтобы купить подарок вместе со всеми, что дешевле
   * него; null — подарок не в общем сборе. С моим взносом и без него.
   */
  together_missing: number | null;
  together_others_missing: number | null;
  /** сколько не хватает, чтобы купить подарок в придачу к выбранным по голосам; null — набора нет или подарок уже в нём */
  extra_missing: number | null;
  extra_others_missing: number | null;
  /** доля участников сбора, проголосовавших за подарок, % */
  vote_pct: number | null;
  my_vote: boolean;
  /** входит в итоговый набор: по голосам и в пределах общего бюджета */
  picked: boolean;
  /** подарок кто-то дарит сам — кто именно, не сообщается */
  reserved: boolean;
  reserved_by_me: boolean;
}

export interface Supporter extends User {
  is_me: boolean;
}

export interface FriendPayload {
  friend: Person;
  my_pledge: number | null;
  /** все участники сбора проголосовали — покупаем подарки с picked */
  decided: boolean;
  /** кто скидывается — только для участников сбора, иначе null */
  supporters: Supporter[] | null;
  /** Telegram-группа участников сбора — только для них */
  pool_chat: { link: string; managed: boolean; set_by: User | null } | null;
  /** кто покупает; имя покупателя — только участникам сбора */
  purchase: {
    status: 'buying' | 'bought';
    buyer: User | null;
    is_me: boolean;
    gifts: { id: string; emoji: string; title: string }[];
  } | null;
  /** по возрастанию цены */
  gifts: FriendGift[];
}

export interface GiftDraft {
  id: string | null;
  title: string;
  price: number;
  emoji: string;
  link: string;
  note: string;
  must_have: boolean;
}

export interface LinkPreview {
  title: string | null;
  price: number | null;
  currency: string | null;
  image: string | null;
}
