import { initData } from '../telegram/webapp';
import type { Bootstrap, FriendPayload, Gift, GiftDraft, Room, RoomPreview } from './types';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY ?? '';

export const isBackendConfigured = SUPABASE_URL !== '' && SUPABASE_KEY !== '';

export class ApiError extends Error {
  status: number;
  code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** initData не прошла проверку или устарела — поможет только перезапуск */
  get isAuth() {
    return this.code === '28000';
  }

  /** меня уже нет в этой компании — надо перечитать список компаний */
  get isForbidden() {
    return this.code === 'WL403';
  }
}

// Supabase Data API: POST /rest/v1/rpc/<функция> с именованными аргументами.
// initData уходит в каждом запросе — база сама проверяет её подпись.
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
  };
  // legacy anon key — это JWT, его PostgREST ждёт ещё и в Authorization
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_KEY}`;

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_init_data: initData, ...args }),
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет', 0);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { message?: string; code?: string };
    throw new ApiError(err.message || `Ошибка сервера (${res.status})`, res.status, err.code);
  }
  return body as T;
}

export const api = {
  /** roomId — какую компанию открыть; null — последнюю открытую */
  bootstrap: (roomId: string | null) => rpc<Bootstrap>('wl_bootstrap', { p_room_id: roomId }),

  createRoom: (name: string, currency: string) =>
    rpc<Room>('wl_create_room', { p_name: name, p_currency: currency }),

  roomPreview: (inviteCode: string) => rpc<RoomPreview>('wl_room_preview', { p_invite_code: inviteCode }),

  joinRoom: (inviteCode: string) => rpc<Room>('wl_join_room', { p_invite_code: inviteCode }),

  leaveRoom: (roomId: string) => rpc<{ left: boolean }>('wl_leave_room', { p_room_id: roomId }),

  saveGift: (roomId: string, gift: GiftDraft) =>
    rpc<Gift>('wl_save_gift', {
      p_room_id: roomId,
      p_gift_id: gift.id,
      p_title: gift.title,
      p_price: gift.price,
      p_emoji: gift.emoji,
      p_link: gift.link.trim() || null,
    }),

  /** image — data URL; пустая строка убирает фото */
  setGiftImage: (giftId: string, image: string) =>
    rpc<Gift>('wl_set_gift_image', { p_gift_id: giftId, p_image: image }),

  giftImages: (giftIds: string[]) =>
    rpc<Record<string, { rev: number; data: string }>>('wl_gift_images', { p_gift_ids: giftIds }),

  deleteGift: (giftId: string) => rpc<{ deleted: boolean }>('wl_delete_gift', { p_gift_id: giftId }),

  friend: (roomId: string, friendId: number) =>
    rpc<FriendPayload>('wl_friend', { p_room_id: roomId, p_friend_id: friendId }),

  setPledge: (roomId: string, friendId: number, amount: number) =>
    rpc<FriendPayload>('wl_set_pledge', { p_room_id: roomId, p_friend_id: friendId, p_amount: amount }),

  /** reserve: true — «подарю сам», false — снять свою бронь */
  reserveGift: (roomId: string, giftId: string, reserve: boolean) =>
    rpc<FriendPayload>('wl_reserve_gift', { p_room_id: roomId, p_gift_id: giftId, p_reserve: reserve }),

  vote: (roomId: string, friendId: number, giftId: string | null) =>
    rpc<FriendPayload>('wl_vote', { p_room_id: roomId, p_friend_id: friendId, p_gift_id: giftId }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Что-то пошло не так';
}
