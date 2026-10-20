import { useState } from 'react';
import type { User } from '../api/types';

// Те же градиенты, что Telegram рисует пользователям без фото
const PALETTE: [string, string][] = [
  ['#ff885e', '#ff516a'],
  ['#ffcd6a', '#ffa85c'],
  ['#82b1ff', '#665fff'],
  ['#a0de7e', '#54cb68'],
  ['#53edd6', '#28c9b7'],
  ['#72d5fd', '#2a9ef1'],
  ['#e0a2f3', '#d669ed'],
];

type AvatarUser = Pick<User, 'id' | 'first_name' | 'last_name' | 'photo_url'>;

function initials(user: AvatarUser) {
  const a = user.first_name?.trim()[0] ?? '';
  const b = user.last_name?.trim()[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

export function Avatar({ user, size = 40, className = '' }: { user: AvatarUser; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const [from, to] = PALETTE[Math.abs(user.id) % PALETTE.length];

  if (user.photo_url && !broken) {
    return (
      <img
        src={user.photo_url}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `linear-gradient(180deg, ${from}, ${to})`,
      }}
    >
      {initials(user)}
    </div>
  );
}

export function AvatarStack({ users, size = 24, max = 4 }: { users: AvatarUser[]; size?: number; max?: number }) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((u, i) => (
        <div
          key={u.id}
          className="rounded-full ring-2 ring-[var(--card)]"
          style={{ marginLeft: i === 0 ? 0 : -size * 0.3, zIndex: shown.length - i }}
        >
          <Avatar user={u} size={size} />
        </div>
      ))}
      {rest > 0 && (
        <div
          className="flex items-center justify-center rounded-full bg-fill font-semibold text-hint ring-2 ring-[var(--card)]"
          style={{ width: size, height: size, marginLeft: -size * 0.3, fontSize: Math.round(size * 0.4) }}
        >
          +{rest}
        </div>
      )}
    </div>
  );
}
