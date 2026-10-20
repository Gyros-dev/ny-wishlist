export interface User {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  photo_url: string | null;
}

export interface Room {
  id: string;
  name: string;
  /** ISO 4217 */
  currency: string;
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
  /** версия фото; null — фото нет */
  image_rev: number | null;
  created_at: string;
}

/** Участник компании глазами другого участника — без сумм и числа скинувшихся */
export interface Member extends User {
  gift_count: number;
  min_price: number | null;
  /** сколько собрано на каждый подарок, % по возрастанию цены */
  progress: number[];
  funded_count: number;
  my_pledge: number | null;
  leader: { id: string; emoji: string; title: string } | null;
}

export interface Bootstrap {
  me: User;
  rooms: Room[];
  /** открытая компания; null — компаний пока нет */
  room: Room | null;
  gifts: Gift[];
  /** скидывается ли мне хоть кто-то — без сумм и числа людей */
  has_supporters: boolean;
  members: Member[];
}

export interface FriendGift extends Gift {
  /** собрано от цены вместе с моим взносом, % */
  pct: number;
  /** собрано без моего взноса, % — для предпросмотра суммы */
  others_pct: number;
  funded: boolean;
  /** доля голосов, %; null — голосов нет */
  vote_pct: number | null;
  is_leader: boolean;
}

export interface FriendPayload {
  friend: User;
  my_pledge: number | null;
  my_vote: string | null;
  /** все участники сбора проголосовали — этот подарок покупаем */
  decided_gift_id: string | null;
  /** по возрастанию цены */
  gifts: FriendGift[];
}

export interface GiftDraft {
  id: string | null;
  title: string;
  price: number;
  emoji: string;
  link: string;
}
