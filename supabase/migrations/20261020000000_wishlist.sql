-- Новогодний вишлист: схема и RPC для Telegram Mini App.
--
-- Таблицы живут в схеме app, которую Supabase Data API не публикует. Клиент
-- общается с базой только через функции public.wl_*: каждая принимает
-- Telegram initData, проверяет её подпись токеном бота (HMAC-SHA256, как в
-- документации Telegram) и только после этого читает или пишет данные.
--
-- Всё происходит внутри компаний (rooms): вишлисты, взносы и голоса видят
-- только участники компании, вступившие по ссылке-приглашению. Суммы не
-- уходят наружу никому — только проценты сбора. Кто скидывается и ссылку на
-- чат сбора видят только сами участники этого сбора; кто за что голосовал и
-- кто забронировал подарок, не видит никто, а владелец вишлиста не видит
-- ни участников, ни голосов, ни броней.
--
-- После применения миграции задайте токен бота:
--   insert into app.settings (key, value) values ('bot_token', '123456:ABC...')
--   on conflict (key) do update set value = excluded.value;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- pg_net: из базы настраивается вебхук бота (app.setup_telegram_webhook)
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net недоступен — вебхук бота придётся настроить вручную';
end;
$$;

create schema if not exists app;

-- Повторное применение: у RPC могли поменяться аргументы, старые версии
-- удаляем, чтобы Data API не путался в перегрузках. Данные не трогаются.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'wl\_%'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

create table if not exists app.settings (
  key text primary key,
  value text not null
);

insert into app.settings (key, value)
values ('init_data_max_age', '86400')
on conflict (key) do nothing;

-- часовой пояс для напоминаний перед Новым годом
insert into app.settings (key, value)
values ('reminder_timezone', 'Asia/Ho_Chi_Minh')
on conflict (key) do nothing;

-- секрет, которым Telegram подписывает запросы к вебхуку бота
insert into app.settings (key, value)
values ('webhook_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

create table if not exists app.users (
  id bigint primary key, -- Telegram user id
  first_name text not null,
  last_name text,
  username text,
  photo_url text,
  -- какую компанию открыть при следующем запуске
  last_room_id uuid,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create table if not exists app.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  -- ISO 4217: VND, RUB, USD...
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  invite_code text not null unique check (invite_code ~ '^[A-Za-z0-9_-]{6,32}$'),
  owner_id bigint references app.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table app.users drop constraint if exists users_last_room_fk;
alter table app.users
  add constraint users_last_room_fk foreign key (last_room_id) references app.rooms (id) on delete set null;

create table if not exists app.room_members (
  room_id uuid not null references app.rooms (id) on delete cascade,
  user_id bigint not null references app.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx on app.room_members (user_id);

-- Подарки, взносы и голоса привязаны к членству в компании: кто вышел из
-- компании, у того всё это удаляется каскадом.
create table if not exists app.gifts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  owner_id bigint not null,
  title text not null check (char_length(title) between 1 and 120),
  price bigint not null check (price > 0 and price <= 1000000000000),
  emoji text not null default '🎁' check (char_length(emoji) between 1 and 16),
  link text check (link is null or char_length(link) <= 500),
  -- размер, цвет, модель — чтобы купили именно то
  note text check (note is null or char_length(note) <= 500),
  -- «очень хочу»
  must_have boolean not null default false,
  -- владелец отметил «мне это подарили» — подарок выпадает из сборов
  received_at timestamptz,
  -- версия фото (мс): меняется при каждой замене, null — фото нет
  image_rev bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (room_id, owner_id) references app.room_members (room_id, user_id) on delete cascade,
  -- для составного внешнего ключа из votes: голос можно отдать только за
  -- подарок из вишлиста того, кому скидываешься, и в той же компании
  unique (id, room_id, owner_id)
);

create index if not exists gifts_room_owner_idx on app.gifts (room_id, owner_id, created_at);

alter table app.gifts add column if not exists note text check (note is null or char_length(note) <= 500);
alter table app.gifts add column if not exists must_have boolean not null default false;
alter table app.gifts add column if not exists received_at timestamptz;

-- Фото подарка: сжатый на клиенте JPEG/PNG/WebP в виде data URL. Хранится
-- отдельно, чтобы списки и опрос шкал не тащили картинки — клиент
-- догружает их по image_rev и кэширует.
create table if not exists app.gift_images (
  gift_id uuid primary key references app.gifts (id) on delete cascade,
  data text not null check (char_length(data) <= 450000),
  updated_at timestamptz not null default now()
);

-- Сколько участник готов потратить на конкретного друга в компании
create table if not exists app.pledges (
  room_id uuid not null,
  giver_id bigint not null,
  recipient_id bigint not null,
  amount bigint not null check (amount > 0 and amount <= 1000000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_id, giver_id, recipient_id),
  foreign key (room_id, giver_id) references app.room_members (room_id, user_id) on delete cascade,
  foreign key (room_id, recipient_id) references app.room_members (room_id, user_id) on delete cascade,
  check (giver_id <> recipient_id)
);

create index if not exists pledges_recipient_idx on app.pledges (room_id, recipient_id);

-- Голоса за подарки, которые покупаем: участник сбора может голосовать за
-- несколько. Пропадают вместе со взносом и вместе с удалённым подарком.
create table if not exists app.votes (
  room_id uuid not null,
  voter_id bigint not null,
  recipient_id bigint not null,
  gift_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (room_id, voter_id, recipient_id, gift_id),
  foreign key (room_id, voter_id, recipient_id)
    references app.pledges (room_id, giver_id, recipient_id) on delete cascade,
  foreign key (gift_id, room_id, recipient_id)
    references app.gifts (id, room_id, owner_id) on delete cascade
);

create index if not exists votes_gift_idx on app.votes (gift_id);

-- В первой версии голос был один на сбор — расширяем ключ на месте
alter table app.votes drop constraint if exists votes_pkey;
alter table app.votes add constraint votes_pkey primary key (room_id, voter_id, recipient_id, gift_id);

-- Ссылка на Telegram-группу участников сбора: создаёт её кто-то из них
-- (бот создавать группы не может), а видят только участники этого сбора.
create table if not exists app.pool_chats (
  room_id uuid not null,
  recipient_id bigint not null,
  invite_link text not null check (invite_link ~ '^https://t\.me/'),
  set_by bigint references app.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (room_id, recipient_id),
  foreign key (room_id, recipient_id) references app.room_members (room_id, user_id) on delete cascade
);

-- чат, который бот создал или к которому привязан: в него он пускает только
-- участников сбора; null — ссылку вставили вручную
alter table app.pool_chats add column if not exists chat_id bigint;
create unique index if not exists pool_chats_chat_id_idx on app.pool_chats (chat_id);

-- Кто покупает подарок от сбора: один из участников берёт покупку на себя,
-- потом отмечает «Куплено» — сбор закрывается. Если покупатель выходит из
-- сбора, отметка пропадает вместе с его взносом.
create table if not exists app.pool_purchases (
  room_id uuid not null,
  recipient_id bigint not null,
  buyer_id bigint not null,
  status text not null default 'buying' check (status in ('buying', 'bought')),
  gift_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (room_id, recipient_id),
  foreign key (room_id, buyer_id, recipient_id)
    references app.pledges (room_id, giver_id, recipient_id) on delete cascade
);

-- Журнал уведомлений бота (сами сообщения уходят через pg_net)
create table if not exists app.notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on app.notifications (user_id, created_at);

-- Тайный Санта: каждый участник дарит подарок одному случайному другому.
-- Кому дарит, знает только он сам — даже создатель компании не видит.
create table if not exists app.santa (
  room_id uuid primary key references app.rooms (id) on delete cascade,
  budget bigint check (budget is null or (budget > 0 and budget <= 1000000000000)),
  status text not null default 'open' check (status in ('open', 'drawn')),
  drawn_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app.santa_members (
  room_id uuid not null references app.santa (room_id) on delete cascade,
  user_id bigint not null,
  receiver_id bigint,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references app.room_members (room_id, user_id) on delete cascade
);

-- «Создать чат сбора»: request_id уходит в кнопку KeyboardButtonRequestChat
-- и возвращается боту в chat_shared — так бот узнаёт, чей это сбор
create table if not exists app.pool_chat_requests (
  request_id integer primary key,
  room_id uuid not null,
  recipient_id bigint not null,
  created_by bigint not null,
  created_at timestamptz not null default now(),
  foreign key (room_id, recipient_id) references app.room_members (room_id, user_id) on delete cascade,
  foreign key (room_id, created_by) references app.room_members (room_id, user_id) on delete cascade
);

-- Бронь: участник дарит подарок целиком сам, без общего сбора. Кто
-- забронировал, знает только он сам; владелец вишлиста не видит даже факта
-- брони. Пропадает вместе с подарком и с выходом участника из компании.
create table if not exists app.reservations (
  gift_id uuid primary key,
  room_id uuid not null,
  owner_id bigint not null,
  reserver_id bigint not null,
  created_at timestamptz not null default now(),
  foreign key (gift_id, room_id, owner_id)
    references app.gifts (id, room_id, owner_id) on delete cascade,
  foreign key (room_id, reserver_id)
    references app.room_members (room_id, user_id) on delete cascade,
  check (reserver_id <> owner_id)
);

create index if not exists reservations_reserver_idx on app.reservations (room_id, reserver_id);

alter table app.settings enable row level security;
alter table app.users enable row level security;
alter table app.rooms enable row level security;
alter table app.room_members enable row level security;
alter table app.gifts enable row level security;
alter table app.gift_images enable row level security;
alter table app.pledges enable row level security;
alter table app.votes enable row level security;
alter table app.reservations enable row level security;
alter table app.pool_chats enable row level security;
alter table app.pool_chat_requests enable row level security;
alter table app.pool_purchases enable row level security;
alter table app.notifications enable row level security;
alter table app.santa enable row level security;
alter table app.santa_members enable row level security;

-- ---------------------------------------------------------------------------
-- Проверка Telegram initData
-- ---------------------------------------------------------------------------

create or replace function app.url_decode(p_input text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_result bytea := ''::bytea;
  v_i integer := 1;
  v_len integer := length(p_input);
  v_ch text;
begin
  while v_i <= v_len loop
    v_ch := substr(p_input, v_i, 1);
    if v_ch = '%' and substr(p_input, v_i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
      v_result := v_result || decode(substr(p_input, v_i + 1, 2), 'hex');
      v_i := v_i + 3;
    else
      v_result := v_result || convert_to(case when v_ch = '+' then ' ' else v_ch end, 'UTF8');
      v_i := v_i + 1;
    end if;
  end loop;
  return convert_from(v_result, 'UTF8');
end;
$$;

-- Проверяет подпись initData и возвращает id пользователя Telegram,
-- попутно создавая или обновляя его профиль.
-- https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
create or replace function app.auth(p_init_data text)
returns bigint
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_token text;
  v_max_age integer;
  v_check text;
  v_hash text;
  v_auth_date text;
  v_user_raw text;
  v_user jsonb;
  v_id bigint;
  v_secret bytea;
  v_photo text;
begin
  if coalesce(p_init_data, '') = '' then
    raise exception 'Откройте вишлист из Telegram' using errcode = '28000';
  end if;

  select s.value into v_token from app.settings s where s.key = 'bot_token';
  if v_token is null then
    raise exception 'Сервер не настроен: не задан bot_token' using errcode = '28000';
  end if;

  select s.value::integer into v_max_age from app.settings s where s.key = 'init_data_max_age';

  -- data-check-string: все поля, кроме hash, отсортированные по ключу
  -- побайтово (collate "C"), в формате key=value через перевод строки
  select
    string_agg(kv.k || '=' || kv.v, E'\n' order by kv.k collate "C") filter (where kv.k <> 'hash'),
    max(kv.v) filter (where kv.k = 'hash'),
    max(kv.v) filter (where kv.k = 'auth_date'),
    max(kv.v) filter (where kv.k = 'user')
  into v_check, v_hash, v_auth_date, v_user_raw
  from (
    select
      app.url_decode(split_part(pair, '=', 1)) as k,
      app.url_decode(substr(pair, strpos(pair, '=') + 1)) as v
    from unnest(string_to_array(p_init_data, '&')) as pair
    where strpos(pair, '=') > 1
  ) kv;

  v_secret := extensions.hmac(convert_to(v_token, 'UTF8'), convert_to('WebAppData', 'UTF8'), 'sha256');

  if v_hash is null or v_check is null
     or encode(extensions.hmac(convert_to(v_check, 'UTF8'), v_secret, 'sha256'), 'hex') <> lower(v_hash) then
    raise exception 'Не удалось проверить данные Telegram' using errcode = '28000';
  end if;

  if v_auth_date !~ '^[0-9]{1,12}$'
     or extract(epoch from now()) - v_auth_date::bigint > coalesce(v_max_age, 86400) then
    raise exception 'Сессия устарела — закройте и снова откройте вишлист' using errcode = '28000';
  end if;

  v_user := v_user_raw::jsonb;
  v_id := (v_user ->> 'id')::bigint;
  if v_id is null then
    raise exception 'В данных Telegram нет пользователя' using errcode = '28000';
  end if;

  v_photo := nullif(v_user ->> 'photo_url', '');
  if v_photo !~ '^https://' then
    v_photo := null;
  end if;

  insert into app.users as u (id, first_name, last_name, username, photo_url)
  values (
    v_id,
    left(coalesce(nullif(btrim(v_user ->> 'first_name'), ''), 'Без имени'), 64),
    left(nullif(btrim(v_user ->> 'last_name'), ''), 64),
    nullif(v_user ->> 'username', ''),
    v_photo
  )
  on conflict (id) do update
    set first_name = excluded.first_name,
        last_name = excluded.last_name,
        username = excluded.username,
        photo_url = excluded.photo_url,
        seen_at = now()
    where (u.first_name, u.last_name, u.username, u.photo_url)
            is distinct from (excluded.first_name, excluded.last_name, excluded.username, excluded.photo_url)
       or u.seen_at < now() - interval '1 hour';

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Вспомогательное
-- ---------------------------------------------------------------------------

create or replace function app.require_member(p_room_id uuid, p_user_id bigint)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_room_id is null or not exists (
    select 1 from app.room_members m where m.room_id = p_room_id and m.user_id = p_user_id
  ) then
    -- WL403: клиент понимает, что компанию надо перечитать
    raise exception 'Вы не состоите в этой компании' using errcode = 'WL403';
  end if;
end;
$$;

-- Доля собранного от цены, целыми процентами вниз, не больше 100
create or replace function app.pct(p_amount numeric, p_price numeric)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(100, floor(greatest(p_amount, 0) * 100 / p_price))::integer;
$$;

-- Подарок-лидер голосования — только если он единственный с максимумом голосов
drop function if exists app.leader_gift(uuid, bigint);

-- Итоговый набор подарков: по числу голосов (при равенстве — сначала
-- дешевле), пока хватает общего бюджета. Если собрали на несколько
-- подарков, в покупку попадают несколько.
create or replace function app.picked_gifts(p_room_id uuid, p_recipient_id bigint)
returns uuid[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_budget numeric;
  v_picked uuid[] := '{}';
  r record;
begin
  select coalesce(sum(p.amount), 0) into v_budget
  from app.pledges p
  where p.room_id = p_room_id and p.recipient_id = p_recipient_id;

  -- в сборе только подарки, которые никто не дарит сам и которые ещё не подарены
  for r in
    select g.id, g.price
    from app.votes v
    join app.gifts g on g.id = v.gift_id and g.received_at is null
    where v.room_id = p_room_id and v.recipient_id = p_recipient_id
      and not exists (select 1 from app.reservations rv where rv.gift_id = g.id)
    group by g.id, g.price, g.created_at
    order by count(*) desc, g.price, g.created_at
  loop
    if r.price <= v_budget then
      v_picked := v_picked || r.id;
      v_budget := v_budget - r.price;
    end if;
  end loop;
  return v_picked;
end;
$$;

-- Все участники сбора проголосовали хотя бы за один подарок
create or replace function app.pool_decided(p_room_id uuid, p_recipient_id bigint)
returns boolean
language sql
stable
set search_path = ''
as $$
  select s.n > 0 and v.n = s.n
  from (
    select count(*) as n from app.pledges p
    where p.room_id = p_room_id and p.recipient_id = p_recipient_id
  ) s,
  (
    select count(distinct vt.voter_id) as n
    from app.votes vt
    join app.gifts g on g.id = vt.gift_id and g.received_at is null
    where vt.room_id = p_room_id and vt.recipient_id = p_recipient_id
      and not exists (select 1 from app.reservations rv where rv.gift_id = vt.gift_id)
  ) v;
$$;

-- Подарки общего сбора, на которые уже хватает
create or replace function app.pool_funded(p_room_id uuid, p_recipient_id bigint)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(g.id order by g.price), '{}')
  from app.gifts g
  where g.room_id = p_room_id and g.owner_id = p_recipient_id and g.received_at is null
    and not exists (select 1 from app.reservations rv where rv.gift_id = g.id)
    and g.price <= (
      select coalesce(sum(p.amount), 0) from app.pledges p
      where p.room_id = p_room_id and p.recipient_id = p_recipient_id
    );
$$;

create or replace function app.gift_titles(p_ids uuid[])
returns text
language sql
stable
set search_path = ''
as $$
  select string_agg(g.emoji || ' ' || g.title, ', ' order by g.price)
  from app.gifts g
  where g.id = any (p_ids);
$$;

create or replace function app.days_text(p_days integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_days || ' ' || case
    when p_days % 100 between 11 and 14 then 'дней'
    when p_days % 10 = 1 then 'день'
    when p_days % 10 between 2 and 4 then 'дня'
    else 'дней'
  end;
$$;

-- Сообщение от бота в личку. Пишется в журнал и, если есть pg_net и токен,
-- уходит в Telegram после коммита. Ошибки не ломают основное действие.
create or replace function app.notify(p_user_id bigint, p_text text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_token text;
begin
  insert into app.notifications (user_id, text) values (p_user_id, p_text);
  select s.value into v_token from app.settings s where s.key = 'bot_token';
  if v_token is null or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.telegram.org/bot' || v_token || '/sendMessage',
          jsonb_build_object('chat_id', p_user_id, 'text', p_text, 'disable_web_page_preview', true),
          '{"Content-Type": "application/json"}'::jsonb;
exception when others then
  raise notice 'notify failed: %', sqlerrm;
end;
$$;

-- Всем участникам сбора, кроме p_except
create or replace function app.notify_pool(p_room_id uuid, p_recipient_id bigint, p_except bigint, p_text text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select p.giver_id from app.pledges p
    where p.room_id = p_room_id and p.recipient_id = p_recipient_id and p.giver_id is distinct from p_except
  loop
    perform app.notify(r.giver_id, p_text);
  end loop;
end;
$$;

-- Всем участникам компании, кроме p_except
create or replace function app.notify_room(p_room_id uuid, p_except bigint, p_text text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select m.user_id from app.room_members m
    where m.room_id = p_room_id and m.user_id is distinct from p_except
  loop
    perform app.notify(r.user_id, p_text);
  end loop;
end;
$$;

create or replace function app.user_json(p_user app.users)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_user.id,
    'first_name', p_user.first_name,
    'last_name', p_user.last_name,
    'username', p_user.username,
    'photo_url', p_user.photo_url
  );
$$;

create or replace function app.gift_json(p_gift app.gifts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_gift.id,
    'title', p_gift.title,
    'price', p_gift.price,
    'emoji', p_gift.emoji,
    'link', p_gift.link,
    'note', p_gift.note,
    'must_have', p_gift.must_have,
    'received', p_gift.received_at is not null,
    'image_rev', p_gift.image_rev,
    'created_at', p_gift.created_at
  );
$$;

create or replace function app.room_json(p_room app.rooms, p_me bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_room.id,
    'name', p_room.name,
    'currency', p_room.currency,
    'invite_code', p_room.invite_code,
    'is_owner', coalesce(p_room.owner_id = p_me, false),
    'member_count', (select count(*) from app.room_members m where m.room_id = p_room.id)
  );
$$;

create or replace function app.santa_json(p_room_id uuid, p_me bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', s.status,
    'budget', s.budget,
    'participants', coalesce((
      select jsonb_agg(app.user_json(u) order by sm.joined_at, u.id)
      from app.santa_members sm
      join app.users u on u.id = sm.user_id
      where sm.room_id = s.room_id
    ), '[]'::jsonb),
    'joined', exists (select 1 from app.santa_members sm where sm.room_id = s.room_id and sm.user_id = p_me),
    -- кому дарю я — больше никому это не отдаётся
    'receiver', (
      select app.user_json(u)
      from app.santa_members sm
      join app.users u on u.id = sm.receiver_id
      join app.room_members rm on rm.room_id = sm.room_id and rm.user_id = sm.receiver_id
      where sm.room_id = s.room_id and sm.user_id = p_me
    )
  )
  from app.santa s
  where s.room_id = p_room_id;
$$;

-- Всё, что видит участник на странице чужого вишлиста. Сумм, числа
-- скинувшихся и имён голосовавших здесь нет — только проценты:
--   pct        — собрано от цены вместе с моим взносом;
--   others_pct — собрано без моего взноса (для предпросмотра суммы);
--   funded     — хватает ли уже на подарок;
--   missing / others_missing — сколько ещё не хватает (с моим взносом и без);
--   vote_pct   — доля участников сбора, проголосовавших за подарок;
--   picked     — подарок входит в итоговый набор;
--   together_missing / together_others_missing — сколько не хватает, чтобы
--                купить этот подарок вместе со всеми, что дешевле него
--                (самый большой набор подарков, на который хватает сразу);
--   extra_missing / extra_others_missing — сколько не хватает, чтобы купить
--                подарок вместе с итоговым набором (если набор уже есть);
--   reserved / reserved_by_me — подарок кто-то дарит сам / это я.
-- Кто именно забронировал подарок и кто за что голосовал, не отдаётся никому.
create or replace function app.friend_payload(p_room_id uuid, p_me bigint, p_friend bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with pool as (
    select
      coalesce(sum(p.amount), 0) as total,
      coalesce(sum(p.amount) filter (where p.giver_id = p_me), 0) as mine,
      count(*) as supporters,
      coalesce(bool_or(p.giver_id = p_me), false) as i_support
    from app.pledges p
    where p.room_id = p_room_id and p.recipient_id = p_friend
  ),
  tally as (
    select v.gift_id, count(*) as n, bool_or(v.voter_id = p_me) as mine
    from app.votes v
    join app.gifts g on g.id = v.gift_id and g.received_at is null
    where v.room_id = p_room_id and v.recipient_id = p_friend
      and not exists (select 1 from app.reservations r where r.gift_id = v.gift_id)
    group by v.gift_id
  ),
  picked as (
    select app.picked_gifts(p_room_id, p_friend) as ids
  ),
  picked_sum as (
    select coalesce(sum(g.price), 0) as total, count(*) as n
    from app.gifts g, picked
    where g.id = any (picked.ids)
  ),
  -- подарки общего сбора от дешёвых к дорогим с нарастающей суммой цен:
  -- первые N из них — самый большой набор, который можно купить сразу
  pool_gifts as (
    select g.id, sum(g.price) over (
      order by g.price, g.created_at, g.id rows between unbounded preceding and current row
    ) as cum
    from app.gifts g
    where g.room_id = p_room_id and g.owner_id = p_friend and g.received_at is null
      and not exists (select 1 from app.reservations r where r.gift_id = g.id)
  ),
  purchase as (
    select pp.*, app.user_json(b) as buyer
    from app.pool_purchases pp
    join app.users b on b.id = pp.buyer_id
    where pp.room_id = p_room_id and pp.recipient_id = p_friend
  )
  select jsonb_build_object(
    'friend', app.user_json(u),
    'my_pledge', (
      select p.amount from app.pledges p
      where p.room_id = p_room_id and p.recipient_id = p_friend and p.giver_id = p_me
    ),
    -- все участники сбора проголосовали хотя бы за один подарок
    'decided', app.pool_decided(p_room_id, p_friend),
    -- участники сбора и ссылка на их чат — только для самих участников
    'supporters', case when pool.i_support then (
      select jsonb_agg(app.user_json(s) || jsonb_build_object('is_me', s.id = p_me) order by p.created_at, s.id)
      from app.pledges p
      join app.users s on s.id = p.giver_id
      where p.room_id = p_room_id and p.recipient_id = p_friend
    ) end,
    'pool_chat', case when pool.i_support then (
      select jsonb_build_object(
        'link', c.invite_link,
        -- чат привязан к боту: он пускает только участников сбора
        'managed', c.chat_id is not null,
        'set_by', (select app.user_json(a) from app.users a where a.id = c.set_by)
      )
      from app.pool_chats c
      where c.room_id = p_room_id and c.recipient_id = p_friend
    ) end,
    -- кто покупает и что; имя покупателя — только участникам сбора
    'purchase', (
      select jsonb_build_object(
        'status', pc.status,
        'buyer', case when pool.i_support then pc.buyer end,
        'is_me', pc.buyer_id = p_me,
        'gifts', coalesce((
          select jsonb_agg(jsonb_build_object('id', g.id, 'emoji', g.emoji, 'title', g.title) order by g.price)
          from app.gifts g where g.id = any (pc.gift_ids)
        ), '[]'::jsonb)
      )
      from purchase pc
    ),
    'gifts', coalesce((
      select jsonb_agg(
        app.gift_json(g) || jsonb_build_object(
          'pct', app.pct(pool.total, g.price),
          'others_pct', app.pct(pool.total - pool.mine, g.price),
          'funded', pool.total >= g.price,
          -- сколько ещё не хватает: со мной и без моего взноса (для предпросмотра)
          'missing', greatest(g.price - pool.total, 0),
          'others_missing', greatest(g.price - (pool.total - pool.mine), 0),
          'together_missing', case when pg.id is not null then greatest(pg.cum - pool.total, 0) end,
          'together_others_missing', case when pg.id is not null then greatest(pg.cum - (pool.total - pool.mine), 0) end,
          'extra_missing', case when pg.id is not null and ps.n > 0 and not (g.id = any (picked.ids))
            then greatest(ps.total + g.price - pool.total, 0) end,
          'extra_others_missing', case when pg.id is not null and ps.n > 0 and not (g.id = any (picked.ids))
            then greatest(ps.total + g.price - (pool.total - pool.mine), 0) end,
          -- доля участников сбора, проголосовавших за подарок
          'vote_pct', case when pool.supporters > 0 and rv.gift_id is null and g.received_at is null
            then round(coalesce(t.n, 0) * 100.0 / pool.supporters)::integer end,
          'my_vote', coalesce(t.mine, false),
          'picked', g.id = any (picked.ids),
          'reserved', rv.gift_id is not null,
          'reserved_by_me', coalesce(rv.reserver_id = p_me, false)
        )
        order by g.price, g.created_at, g.id
      )
      from app.gifts g
      left join tally t on t.gift_id = g.id
      left join app.reservations rv on rv.gift_id = g.id
      left join pool_gifts pg on pg.id = g.id
      where g.room_id = p_room_id and g.owner_id = p_friend
    ), '[]'::jsonb)
  )
  from app.users u, pool, picked, picked_sum ps
  where u.id = p_friend;
$$;

-- ---------------------------------------------------------------------------
-- RPC: компании
-- ---------------------------------------------------------------------------

-- Стартовый экран: мои компании, открытая компания, мой вишлист в ней и
-- остальные участники с прогрессом сборов. p_room_id — какую компанию
-- открыть; null или чужая — последняя открытая (или любая своя).
create or replace function public.wl_bootstrap(p_init_data text, p_room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_room app.rooms;
begin
  select r.* into v_room
  from app.rooms r
  join app.room_members m on m.room_id = r.id and m.user_id = v_me
  where r.id = coalesce(p_room_id, (select u.last_room_id from app.users u where u.id = v_me));

  if v_room.id is null then
    select r.* into v_room
    from app.rooms r
    join app.room_members m on m.room_id = r.id and m.user_id = v_me
    order by m.joined_at desc
    limit 1;
  end if;

  if v_room.id is not null then
    update app.users u set last_room_id = v_room.id
     where u.id = v_me and u.last_room_id is distinct from v_room.id;
  end if;

  return jsonb_build_object(
    'me', (select app.user_json(u) from app.users u where u.id = v_me),
    'rooms', coalesce((
      select jsonb_agg(app.room_json(r, v_me) order by m.joined_at)
      from app.room_members m
      join app.rooms r on r.id = m.room_id
      where m.user_id = v_me
    ), '[]'::jsonb),
    'room', case when v_room.id is not null then app.room_json(v_room, v_me) end,
    'gifts', coalesce((
      select jsonb_agg(app.gift_json(g) order by g.created_at)
      from app.gifts g
      where g.room_id = v_room.id and g.owner_id = v_me
    ), '[]'::jsonb),
    -- владельцу — только факт, что кто-то скидывается, без сумм и числа людей
    'has_supporters', exists (
      select 1 from app.pledges p where p.room_id = v_room.id and p.recipient_id = v_me
    ),
    'santa', case when v_room.id is not null then app.santa_json(v_room.id, v_me) end,
    'members', coalesce((
      select jsonb_agg(
        app.user_json(u) || jsonb_build_object(
          'gift_count', gs.gift_count,
          'min_price', gs.min_price,
          'progress', coalesce(gs.progress, '[]'::jsonb),
          'funded_count', gs.funded_count,
          'pool_count', gs.pool_count,
          'reserved_count', gs.reserved_count,
          'my_reserved_count', gs.my_reserved_count,
          -- до ближайшего подарка из сбора не хватает (null — хватает на каждый)
          'next_missing', gs.next_missing,
          -- на сколько подарков хватает сразу и сколько не хватает ещё на один
          'together_count', tg.together_count,
          'together_next_missing', tg.together_next_missing,
          'purchase_status', (
            select pp.status from app.pool_purchases pp
            where pp.room_id = m.room_id and pp.recipient_id = u.id
          ),
          'my_pledge', mine.amount,
          'picked', coalesce((
            select jsonb_agg(jsonb_build_object('id', pg.id, 'emoji', pg.emoji, 'title', pg.title) order by pg.price)
            from app.gifts pg
            where pg.id = any (app.picked_gifts(m.room_id, u.id))
          ), '[]'::jsonb)
        )
        order by (mine.amount is null), (gs.gift_count = 0), lower(u.first_name), u.id
      )
      from app.room_members m
      join app.users u on u.id = m.user_id
      join lateral (
        select coalesce(sum(p.amount), 0) as total
        from app.pledges p
        where p.room_id = m.room_id and p.recipient_id = u.id
      ) pl on true
      join lateral (
        select
          count(*) as gift_count,
          min(g.price) as min_price,
          -- забронированные и уже подаренные подарки в прогресс сбора не входят
          jsonb_agg(app.pct(pl.total, g.price) order by g.price, g.created_at)
            filter (where rv.gift_id is null and g.received_at is null) as progress,
          count(*) filter (where rv.gift_id is null and g.received_at is null and g.price <= pl.total) as funded_count,
          count(*) filter (where rv.gift_id is null and g.received_at is null) as pool_count,
          count(rv.gift_id) filter (where g.received_at is null) as reserved_count,
          count(*) filter (where rv.reserver_id = v_me and g.received_at is null) as my_reserved_count,
          min(g.price - pl.total) filter (where rv.gift_id is null and g.received_at is null and g.price > pl.total) as next_missing
        from app.gifts g
        left join app.reservations rv on rv.gift_id = g.id
        where g.room_id = m.room_id and g.owner_id = u.id
      ) gs on true
      join lateral (
        select
          count(*) filter (where c.cum <= pl.total) as together_count,
          min(c.cum - pl.total) filter (where c.cum > pl.total) as together_next_missing
        from (
          select sum(g.price) over (
            order by g.price, g.created_at, g.id rows between unbounded preceding and current row
          ) as cum
          from app.gifts g
          where g.room_id = m.room_id and g.owner_id = u.id and g.received_at is null
            and not exists (select 1 from app.reservations rv where rv.gift_id = g.id)
        ) c
      ) tg on true
      left join app.pledges mine
        on mine.room_id = m.room_id and mine.recipient_id = u.id and mine.giver_id = v_me
      where m.room_id = v_room.id and u.id <> v_me
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.wl_create_room(p_init_data text, p_name text, p_currency text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_name text := btrim(coalesce(p_name, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_room app.rooms;
begin
  if v_name = '' then
    raise exception 'Придумайте название компании';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Название — до 60 символов';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Выберите валюту';
  end if;
  if (select count(*) from app.room_members m where m.user_id = v_me) >= 30 then
    raise exception 'Можно состоять максимум в 30 компаниях';
  end if;

  insert into app.rooms (name, currency, invite_code, owner_id)
  values (v_name, v_currency, encode(extensions.gen_random_bytes(8), 'hex'), v_me)
  returning * into v_room;

  insert into app.room_members (room_id, user_id) values (v_room.id, v_me);
  update app.users u set last_room_id = v_room.id where u.id = v_me;

  return app.room_json(v_room, v_me);
end;
$$;

-- Что за компания по приглашению — для экрана «Вас пригласили»
create or replace function public.wl_room_preview(p_init_data text, p_invite_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_room app.rooms;
begin
  select r.* into v_room from app.rooms r where r.invite_code = p_invite_code;
  if v_room.id is null then
    raise exception 'Приглашение не найдено — попросите у друзей новую ссылку';
  end if;

  return (app.room_json(v_room, v_me) - 'invite_code') || jsonb_build_object(
    'is_member', exists (
      select 1 from app.room_members m where m.room_id = v_room.id and m.user_id = v_me
    ),
    'owner', (select app.user_json(u) from app.users u where u.id = v_room.owner_id),
    'members_preview', coalesce((
      select jsonb_agg(x.j order by x.joined_at)
      from (
        select app.user_json(u) as j, m.joined_at
        from app.room_members m
        join app.users u on u.id = m.user_id
        where m.room_id = v_room.id
        order by m.joined_at
        limit 6
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.wl_join_room(p_init_data text, p_invite_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_room app.rooms;
begin
  select r.* into v_room from app.rooms r where r.invite_code = p_invite_code;
  if v_room.id is null then
    raise exception 'Приглашение не найдено — попросите у друзей новую ссылку';
  end if;

  if not exists (select 1 from app.room_members m where m.room_id = v_room.id and m.user_id = v_me) then
    if (select count(*) from app.room_members m where m.room_id = v_room.id) >= 200 then
      raise exception 'В компании уже 200 участников';
    end if;
    if (select count(*) from app.room_members m where m.user_id = v_me) >= 30 then
      raise exception 'Можно состоять максимум в 30 компаниях';
    end if;
    insert into app.room_members (room_id, user_id) values (v_room.id, v_me);
    perform app.notify_room(v_room.id, v_me, format(
      '👋 %s теперь в «%s». Загляните в приложение — может, пора собрать вишлист',
      (select u.first_name from app.users u where u.id = v_me), v_room.name
    ));
  end if;

  update app.users u set last_room_id = v_room.id where u.id = v_me;
  return app.room_json(v_room, v_me);
end;
$$;

-- Выйти из компании: мои подарки, взносы и голоса в ней удаляются.
-- Последний вышедший удаляет компанию, создатель передаёт её старожилу.
create or replace function public.wl_leave_room(p_init_data text, p_room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
begin
  perform app.require_member(p_room_id, v_me);
  delete from app.room_members m where m.room_id = p_room_id and m.user_id = v_me;

  if not exists (select 1 from app.room_members m where m.room_id = p_room_id) then
    delete from app.rooms r where r.id = p_room_id;
  else
    update app.rooms r
       set owner_id = (
         select m.user_id from app.room_members m
         where m.room_id = p_room_id
         order by m.joined_at
         limit 1
       )
     where r.id = p_room_id and r.owner_id = v_me;
  end if;

  return jsonb_build_object('left', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: вишлист
-- ---------------------------------------------------------------------------

create or replace function public.wl_save_gift(
  p_init_data text,
  p_room_id uuid,
  p_gift_id uuid,
  p_title text,
  p_price bigint,
  p_emoji text,
  p_link text,
  -- необязательные: старые клиенты их не присылают
  p_note text default null,
  p_must_have boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_title text := btrim(coalesce(p_title, ''));
  v_emoji text := coalesce(nullif(btrim(p_emoji), ''), '🎁');
  v_link text := nullif(btrim(coalesce(p_link, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_first boolean;
  v_gift app.gifts;
begin
  perform app.require_member(p_room_id, v_me);

  if v_title = '' then
    raise exception 'Укажите, что подарить';
  end if;
  if char_length(v_title) > 120 then
    raise exception 'Название слишком длинное — до 120 символов';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'Укажите цену подарка';
  end if;
  if p_price > 1000000000000 then
    raise exception 'Слишком большая цена';
  end if;
  if char_length(v_emoji) > 16 then
    v_emoji := '🎁';
  end if;
  if v_link is not null and v_link !~* '^https?://' then
    v_link := 'https://' || v_link;
  end if;
  if char_length(v_link) > 500 then
    raise exception 'Ссылка слишком длинная';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'Комментарий — до 500 символов';
  end if;

  if p_gift_id is null then
    if (select count(*) from app.gifts g where g.room_id = p_room_id and g.owner_id = v_me) >= 30 then
      raise exception 'В вишлисте может быть до 30 подарков';
    end if;
    v_first := not exists (select 1 from app.gifts g where g.room_id = p_room_id and g.owner_id = v_me);
    insert into app.gifts (room_id, owner_id, title, price, emoji, link, note, must_have)
    values (p_room_id, v_me, v_title, p_price, v_emoji, v_link, v_note, coalesce(p_must_have, false))
    returning * into v_gift;
    if v_first then
      perform app.notify_room(p_room_id, v_me, format(
        '🎁 У %s появился вишлист в «%s». Загляните — можно скинуться вместе',
        (select u.first_name from app.users u where u.id = v_me),
        (select r.name from app.rooms r where r.id = p_room_id)
      ));
    end if;
  else
    update app.gifts g
       set title = v_title, price = p_price, emoji = v_emoji, link = v_link,
           note = v_note, must_have = coalesce(p_must_have, false), updated_at = now()
     where g.id = p_gift_id and g.owner_id = v_me and g.room_id = p_room_id
    returning * into v_gift;
    if not found then
      raise exception 'Подарок не найден';
    end if;
  end if;

  return app.gift_json(v_gift);
end;
$$;

-- «Мне это подарили»: подарок выпадает из сборов, голосов и броней
create or replace function public.wl_set_gift_received(p_init_data text, p_gift_id uuid, p_received boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_gift app.gifts;
begin
  update app.gifts g
     set received_at = case when coalesce(p_received, true) then coalesce(g.received_at, now()) end,
         updated_at = now()
   where g.id = p_gift_id and g.owner_id = v_me
  returning * into v_gift;
  if not found then
    raise exception 'Подарок не найден';
  end if;
  if v_gift.received_at is not null then
    delete from app.votes v where v.gift_id = p_gift_id;
  end if;
  return app.gift_json(v_gift);
end;
$$;

create or replace function public.wl_delete_gift(p_init_data text, p_gift_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
begin
  delete from app.gifts g where g.id = p_gift_id and g.owner_id = v_me;
  return jsonb_build_object('deleted', found);
end;
$$;

-- Прикрепить, заменить или убрать ('' / null) фото своего подарка
create or replace function public.wl_set_gift_image(p_init_data text, p_gift_id uuid, p_image text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_gift app.gifts;
  v_head bytea;
begin
  if not exists (select 1 from app.gifts g where g.id = p_gift_id and g.owner_id = v_me) then
    raise exception 'Подарок не найден';
  end if;

  if coalesce(p_image, '') = '' then
    delete from app.gift_images i where i.gift_id = p_gift_id;
    update app.gifts g set image_rev = null, updated_at = now()
     where g.id = p_gift_id
    returning * into v_gift;
    return app.gift_json(v_gift);
  end if;

  if char_length(p_image) > 450000 then
    raise exception 'Картинка слишком большая — нужно до 300 КБ';
  end if;
  if p_image !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Поддерживаются только JPEG, PNG и WebP';
  end if;
  -- Сверяем сигнатуру файла с заявленным типом
  v_head := decode(substr(split_part(p_image, ',', 2), 1, 16), 'base64');
  if not (
    (p_image like 'data:image/jpeg;%' and substr(v_head, 1, 3) = '\xffd8ff'::bytea)
    or (p_image like 'data:image/png;%' and substr(v_head, 1, 8) = '\x89504e470d0a1a0a'::bytea)
    or (p_image like 'data:image/webp;%' and substr(v_head, 1, 4) = '\x52494646'::bytea
        and substr(v_head, 9, 4) = '\x57454250'::bytea)
  ) then
    raise exception 'Файл не похож на картинку';
  end if;

  insert into app.gift_images (gift_id, data)
  values (p_gift_id, p_image)
  on conflict (gift_id) do update set data = excluded.data, updated_at = now();

  update app.gifts g
     set image_rev = greatest(
           (extract(epoch from clock_timestamp()) * 1000)::bigint,
           coalesce(g.image_rev, 0) + 1
         ),
         updated_at = now()
   where g.id = p_gift_id
  returning * into v_gift;
  return app.gift_json(v_gift);
end;
$$;

-- Фото подарков по списку id: { "<id>": { "rev": ..., "data": "data:image/..." } }.
-- Отдаются только подарки из компаний, где состоит спрашивающий.
create or replace function public.wl_gift_images(p_init_data text, p_gift_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
begin
  if coalesce(cardinality(p_gift_ids), 0) > 60 then
    raise exception 'Слишком много картинок за раз';
  end if;
  return coalesce((
    select jsonb_object_agg(g.id, jsonb_build_object('rev', g.image_rev, 'data', i.data))
    from app.gifts g
    join app.gift_images i on i.gift_id = g.id
    join app.room_members m on m.room_id = g.room_id and m.user_id = v_me
    where g.id = any (p_gift_ids)
  ), '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: сбор и голосование
-- ---------------------------------------------------------------------------

create or replace function public.wl_friend(p_init_data text, p_room_id uuid, p_friend_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
begin
  perform app.require_member(p_room_id, v_me);
  if p_friend_id = v_me then
    raise exception 'Свой сбор подсматривать нельзя 🤫';
  end if;
  if not exists (select 1 from app.room_members m where m.room_id = p_room_id and m.user_id = p_friend_id) then
    raise exception 'Участник не найден в этой компании';
  end if;
  return app.friend_payload(p_room_id, v_me, p_friend_id);
end;
$$;

-- Сумма, которую участник готов потратить на друга. 0 или null — выйти из сбора
-- (голос участника удаляется вместе со взносом).
create or replace function public.wl_set_pledge(p_init_data text, p_room_id uuid, p_friend_id bigint, p_amount bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_before uuid[];
  v_new uuid[];
begin
  perform app.require_member(p_room_id, v_me);
  if p_friend_id = v_me then
    raise exception 'Нельзя скинуться на подарок самому себе';
  end if;
  if not exists (select 1 from app.room_members m where m.room_id = p_room_id and m.user_id = p_friend_id) then
    raise exception 'Участник не найден в этой компании';
  end if;
  if exists (
    select 1 from app.pool_purchases pp
    where pp.room_id = p_room_id and pp.recipient_id = p_friend_id and pp.status = 'bought'
  ) then
    raise exception 'Подарок уже куплен — сбор закрыт';
  end if;

  v_before := app.pool_funded(p_room_id, p_friend_id);

  if coalesce(p_amount, 0) <= 0 then
    delete from app.pledges p
     where p.room_id = p_room_id and p.giver_id = v_me and p.recipient_id = p_friend_id;
  else
    if p_amount > 1000000000000 then
      raise exception 'Слишком большая сумма';
    end if;
    insert into app.pledges as p (room_id, giver_id, recipient_id, amount)
    values (p_room_id, v_me, p_friend_id, p_amount)
    on conflict (room_id, giver_id, recipient_id) do update
      set amount = excluded.amount, updated_at = now();
  end if;

  -- на что стало хватать — сообщаем остальным участникам сбора
  select coalesce(array_agg(x), '{}') into v_new
  from unnest(app.pool_funded(p_room_id, p_friend_id)) x
  where x <> all (v_before);
  if cardinality(v_new) > 0 then
    perform app.notify_pool(p_room_id, p_friend_id, v_me, format(
      '✅ Сбор на подарок (кому: %s): уже хватает на %s',
      (select u.first_name from app.users u where u.id = p_friend_id), app.gift_titles(v_new)
    ));
  end if;

  return app.friend_payload(p_room_id, v_me, p_friend_id);
end;
$$;

-- Голос за подарок, который покупаем. null — отозвать голос.
-- Голос за подарок (p_on = true) или его отмена. Можно голосовать за несколько.
-- Голос за подарок (p_on = true) или его отмена. Можно голосовать за несколько.
create or replace function public.wl_vote(p_init_data text, p_room_id uuid, p_friend_id bigint, p_gift_id uuid, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_was_decided boolean;
begin
  perform app.require_member(p_room_id, v_me);
  if exists (
    select 1 from app.pool_purchases pp
    where pp.room_id = p_room_id and pp.recipient_id = p_friend_id and pp.status = 'bought'
  ) then
    raise exception 'Подарок уже куплен — голосование закрыто';
  end if;
  v_was_decided := app.pool_decided(p_room_id, p_friend_id);

  if coalesce(p_on, true) then
    if not exists (
      select 1 from app.pledges p
      where p.room_id = p_room_id and p.giver_id = v_me and p.recipient_id = p_friend_id
    ) then
      raise exception 'Чтобы голосовать, сначала укажите, сколько готовы потратить';
    end if;
    if not exists (
      select 1 from app.gifts g
      where g.id = p_gift_id and g.room_id = p_room_id and g.owner_id = p_friend_id
    ) then
      raise exception 'Подарок не найден';
    end if;
    if exists (select 1 from app.gifts g where g.id = p_gift_id and g.received_at is not null) then
      raise exception 'Этот подарок уже подарили';
    end if;
    if exists (select 1 from app.reservations r where r.gift_id = p_gift_id) then
      raise exception 'Этот подарок уже кто-то дарит сам — выберите другой';
    end if;
    insert into app.votes (room_id, voter_id, recipient_id, gift_id)
    values (p_room_id, v_me, p_friend_id, p_gift_id)
    on conflict do nothing;
  else
    delete from app.votes v
     where v.room_id = p_room_id and v.voter_id = v_me
       and v.recipient_id = p_friend_id and v.gift_id = p_gift_id;
  end if;

  if not v_was_decided and app.pool_decided(p_room_id, p_friend_id) then
    perform app.notify_pool(p_room_id, p_friend_id, v_me, format(
      '🗳 Все проголосовали (кому: %s): %s. Кто возьмёт покупку на себя? Откройте сбор в приложении',
      (select u.first_name from app.users u where u.id = p_friend_id),
      coalesce('покупаем ' || app.gift_titles(app.picked_gifts(p_room_id, p_friend_id)),
               'на выбранные подарки пока не хватает')
    ));
  end if;

  return app.friend_payload(p_room_id, v_me, p_friend_id);
end;
$$;

-- «Я покупаю» / «Отказаться» / «Куплено» / «Вернуть»: p_action = take | release | bought | reopen
create or replace function public.wl_pool_purchase(p_init_data text, p_room_id uuid, p_friend_id bigint, p_action text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_purchase app.pool_purchases;
  v_me_name text;
  v_friend_name text;
  v_gifts uuid[];
begin
  perform app.require_member(p_room_id, v_me);
  if not exists (
    select 1 from app.pledges p
    where p.room_id = p_room_id and p.giver_id = v_me and p.recipient_id = p_friend_id
  ) then
    raise exception 'Покупку берут на себя участники сбора';
  end if;
  select u.first_name into v_me_name from app.users u where u.id = v_me;
  select u.first_name into v_friend_name from app.users u where u.id = p_friend_id;
  select pp.* into v_purchase from app.pool_purchases pp
  where pp.room_id = p_room_id and pp.recipient_id = p_friend_id;

  if p_action = 'take' then
    if v_purchase.buyer_id is not null and v_purchase.buyer_id <> v_me then
      raise exception 'Покупку уже взял(а) %', (select u.first_name from app.users u where u.id = v_purchase.buyer_id);
    end if;
    v_gifts := app.picked_gifts(p_room_id, p_friend_id);
    if cardinality(v_gifts) = 0 then
      if exists (select 1 from app.votes v where v.room_id = p_room_id and v.recipient_id = p_friend_id) then
        raise exception 'На выбранные подарки пока не хватает — дождитесь взносов или проголосуйте за другое';
      end if;
      raise exception 'Сначала проголосуйте: пока не выбрано, что покупать';
    end if;
    insert into app.pool_purchases (room_id, recipient_id, buyer_id, status, gift_ids)
    values (p_room_id, p_friend_id, v_me, 'buying', v_gifts)
    on conflict (room_id, recipient_id) do update
      set gift_ids = excluded.gift_ids, status = 'buying', updated_at = now();
    perform app.notify_pool(p_room_id, p_friend_id, v_me, format(
      '🛍 %s берёт на себя покупку (кому: %s): %s. Договоритесь в чате сбора, как скинуться',
      v_me_name, v_friend_name, app.gift_titles(v_gifts)
    ));
  elsif p_action in ('release', 'bought', 'reopen') then
    if v_purchase.buyer_id is distinct from v_me then
      raise exception 'Это может сделать только тот, кто покупает';
    end if;
    if p_action = 'release' then
      delete from app.pool_purchases pp where pp.room_id = p_room_id and pp.recipient_id = p_friend_id;
      perform app.notify_pool(p_room_id, p_friend_id, v_me, format(
        '↩️ %s больше не покупает подарок (кому: %s) — кто-то может взять покупку на себя', v_me_name, v_friend_name
      ));
    elsif p_action = 'bought' then
      update app.pool_purchases pp set status = 'bought', updated_at = now()
       where pp.room_id = p_room_id and pp.recipient_id = p_friend_id;
      perform app.notify_pool(p_room_id, p_friend_id, v_me, format(
        '🎉 Подарок куплен (кому: %s): %s. Спасибо, что скинулись!', v_friend_name, app.gift_titles(v_purchase.gift_ids)
      ));
    else
      update app.pool_purchases pp set status = 'buying', updated_at = now()
       where pp.room_id = p_room_id and pp.recipient_id = p_friend_id;
    end if;
  else
    raise exception 'Неизвестное действие';
  end if;

  return app.friend_payload(p_room_id, v_me, p_friend_id);
end;
$$;

-- Тайный Санта: p_action = open (создатель компании, с бюджетом) | join | leave |
-- draw (создатель, от трёх участников) | cancel (создатель)
create or replace function public.wl_santa(p_init_data text, p_room_id uuid, p_action text, p_budget bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_room app.rooms;
  v_santa app.santa;
  v_count integer;
  r record;
begin
  perform app.require_member(p_room_id, v_me);
  select ro.* into v_room from app.rooms ro where ro.id = p_room_id;
  select sa.* into v_santa from app.santa sa where sa.room_id = p_room_id;

  if p_action in ('open', 'draw', 'cancel') and v_room.owner_id is distinct from v_me then
    raise exception 'Тайного Санту запускает создатель компании';
  end if;

  if p_action = 'open' then
    if v_santa.status = 'drawn' then
      raise exception 'Жеребьёвка уже прошла';
    end if;
    if p_budget is not null and (p_budget <= 0 or p_budget > 1000000000000) then
      raise exception 'Укажите бюджет больше нуля';
    end if;
    insert into app.santa (room_id, budget) values (p_room_id, p_budget)
    on conflict (room_id) do update set budget = excluded.budget;
    insert into app.santa_members (room_id, user_id) values (p_room_id, v_me) on conflict do nothing;
    if v_santa.room_id is null then
      perform app.notify_room(p_room_id, v_me, format(
        '🎅 В «%s» начался Тайный Санта%s. Откройте приложение и нажмите «Участвую»',
        v_room.name, coalesce(' — бюджет до ' || p_budget || ' ' || v_room.currency, '')
      ));
    end if;
  elsif p_action in ('join', 'leave') then
    if v_santa.room_id is null then
      raise exception 'Тайный Санта ещё не начался';
    end if;
    if v_santa.status = 'drawn' then
      raise exception 'Жеребьёвка уже прошла';
    end if;
    if p_action = 'join' then
      insert into app.santa_members (room_id, user_id) values (p_room_id, v_me) on conflict do nothing;
    else
      delete from app.santa_members sm where sm.room_id = p_room_id and sm.user_id = v_me;
    end if;
  elsif p_action = 'draw' then
    if v_santa.room_id is null or v_santa.status = 'drawn' then
      raise exception 'Сначала откройте набор участников';
    end if;
    select count(*) into v_count from app.santa_members sm where sm.room_id = p_room_id;
    if v_count < 3 then
      raise exception 'Для жеребьёвки нужно хотя бы три участника';
    end if;
    -- случайный порядок по кругу: каждый дарит следующему, сам себе — никто
    with ordered as (
      select sm.user_id, row_number() over (order by random()) as rn, count(*) over () as n
      from app.santa_members sm
      where sm.room_id = p_room_id
    )
    update app.santa_members sm
       set receiver_id = nxt.user_id
      from ordered cur
      join ordered nxt on nxt.rn = (cur.rn % cur.n) + 1
     where sm.room_id = p_room_id and sm.user_id = cur.user_id;
    update app.santa sa set status = 'drawn', drawn_at = now() where sa.room_id = p_room_id;
    for r in
      select sm.user_id, u.first_name
      from app.santa_members sm
      join app.users u on u.id = sm.receiver_id
      where sm.room_id = p_room_id
    loop
      perform app.notify(r.user_id, format(
        '🎅 Тайный Санта в «%s»: вы дарите подарок — %s. Это секрет! Вишлист — в приложении%s',
        v_room.name, r.first_name, coalesce(', бюджет до ' || v_santa.budget || ' ' || v_room.currency, '')
      ));
    end loop;
  elsif p_action = 'cancel' then
    delete from app.santa sa where sa.room_id = p_room_id;
  else
    raise exception 'Неизвестное действие';
  end if;

  return app.santa_json(p_room_id, v_me);
end;
$$;

-- Ссылка на Telegram-группу участников сбора. Задать или убрать ('' / null)
-- её может любой участник сбора.
create or replace function public.wl_set_pool_chat(p_init_data text, p_room_id uuid, p_friend_id bigint, p_link text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_link text := btrim(coalesce(p_link, ''));
begin
  perform app.require_member(p_room_id, v_me);
  if not exists (
    select 1 from app.pledges p
    where p.room_id = p_room_id and p.giver_id = v_me and p.recipient_id = p_friend_id
  ) then
    raise exception 'Чат сбора доступен только тем, кто скидывается';
  end if;

  if v_link = '' then
    delete from app.pool_chats c where c.room_id = p_room_id and c.recipient_id = p_friend_id;
  else
    -- t.me/+код, t.me/joinchat/код или публичная группа t.me/имя
    v_link := regexp_replace(v_link, '^(https?://)?(www\.)?(t\.me|telegram\.me)/', 'https://t.me/', 'i');
    if v_link !~ '^https://t\.me/(\+[A-Za-z0-9_-]{6,}|joinchat/[A-Za-z0-9_-]{6,}|[A-Za-z][A-Za-z0-9_]{3,31})/?$' then
      raise exception 'Нужна ссылка-приглашение в Telegram: t.me/+… или t.me/имя_группы';
    end if;
    insert into app.pool_chats (room_id, recipient_id, invite_link, set_by)
    values (p_room_id, p_friend_id, v_link, v_me)
    on conflict (room_id, recipient_id) do update
      set invite_link = excluded.invite_link, set_by = excluded.set_by, chat_id = null, updated_at = now();
  end if;

  return app.friend_payload(p_room_id, v_me, p_friend_id);
end;
$$;

-- Забронировать подарок друга (подарю сам) или снять свою бронь.
-- Забронированный подарок выпадает из общего сбора: голоса за него сбрасываются.
create or replace function public.wl_reserve_gift(p_init_data text, p_room_id uuid, p_gift_id uuid, p_reserve boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_gift app.gifts;
  v_reserver bigint;
begin
  perform app.require_member(p_room_id, v_me);
  select g.* into v_gift from app.gifts g where g.id = p_gift_id and g.room_id = p_room_id;
  if v_gift.id is null then
    raise exception 'Подарок не найден';
  end if;
  if v_gift.owner_id = v_me then
    raise exception 'Свой подарок бронировать не нужно 🙂';
  end if;
  if coalesce(p_reserve, true) and v_gift.received_at is not null then
    raise exception 'Этот подарок уже подарили';
  end if;

  if coalesce(p_reserve, true) then
    select r.reserver_id into v_reserver from app.reservations r where r.gift_id = p_gift_id;
    if v_reserver is not null and v_reserver <> v_me then
      raise exception 'Этот подарок уже кто-то дарит';
    end if;
    if v_reserver is null then
      if (select count(*) from app.reservations r where r.room_id = p_room_id and r.reserver_id = v_me) >= 20 then
        raise exception 'Можно забронировать не больше 20 подарков';
      end if;
      insert into app.reservations (gift_id, room_id, owner_id, reserver_id)
      values (p_gift_id, p_room_id, v_gift.owner_id, v_me)
      on conflict (gift_id) do nothing;
      if not found then
        raise exception 'Этот подарок уже кто-то дарит';
      end if;
      delete from app.votes v where v.gift_id = p_gift_id;
    end if;
  else
    delete from app.reservations r where r.gift_id = p_gift_id and r.reserver_id = v_me;
  end if;

  return app.friend_payload(p_room_id, v_me, v_gift.owner_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Напоминания перед Новым годом: за 14, 7, 3 и 1 день — пустым вишлистам и
-- незакрытым сборам. Запускается ежедневно через pg_cron (ниже).
-- ---------------------------------------------------------------------------

create or replace function app.daily_reminders(p_today date default null)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_days integer;
  v_sent integer := 0;
  r record;
begin
  select coalesce((select s.value from app.settings s where s.key = 'reminder_timezone'), 'UTC') into v_tz;
  v_today := coalesce(p_today, (now() at time zone v_tz)::date);
  v_days := make_date(extract(year from v_today)::integer + 1, 1, 1) - v_today;
  if v_days not in (14, 7, 3, 1) then
    return 0;
  end if;

  -- пустой вишлист в компании, где есть ещё кто-то
  for r in
    select m.user_id, ro.name
    from app.room_members m
    join app.rooms ro on ro.id = m.room_id
    where not exists (
      select 1 from app.gifts g
      where g.room_id = m.room_id and g.owner_id = m.user_id and g.received_at is null
    )
      and exists (select 1 from app.room_members o where o.room_id = m.room_id and o.user_id <> m.user_id)
  loop
    perform app.notify(r.user_id, format(
      '🎄 До Нового года %s, а ваш вишлист в «%s» пока пустой. Добавьте пару желаний — друзьям будет из чего выбрать',
      app.days_text(v_days), r.name
    ));
    v_sent := v_sent + 1;
  end loop;

  -- участник незакрытого сбора
  for r in
    select p.giver_id, u.first_name, ro.name
    from app.pledges p
    join app.users u on u.id = p.recipient_id
    join app.rooms ro on ro.id = p.room_id
    where not exists (
      select 1 from app.pool_purchases pp
      where pp.room_id = p.room_id and pp.recipient_id = p.recipient_id and pp.status = 'bought'
    )
  loop
    perform app.notify(r.giver_id, format(
      '⏰ До Нового года %s. Сбор на подарок (кому: %s, «%s») ещё не закрыт — договоритесь, кто покупает',
      app.days_text(v_days), r.first_name, r.name
    ));
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'wishlist-reminders';
  -- 03:00 UTC: утро во Вьетнаме и в Москве
  perform cron.schedule('wishlist-reminders', '0 3 * * *', 'select app.daily_reminders()');
exception when others then
  raise notice 'pg_cron недоступен — напоминания не запланированы';
end;
$$;

-- ---------------------------------------------------------------------------
-- Бот: эти функции вызывает Edge Function telegram-bot напрямую через
-- SUPABASE_DB_URL. Снаружи (Data API) они недоступны — схема app закрыта.
-- ---------------------------------------------------------------------------

-- Мини-приложение просит бота подготовить кнопку «Создать чат сбора»
create or replace function app.bot_prepare_chat(p_init_data text, p_room_id uuid, p_friend_id bigint)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_me bigint := app.auth(p_init_data);
  v_id integer;
begin
  perform app.require_member(p_room_id, v_me);
  if not exists (
    select 1 from app.pledges p
    where p.room_id = p_room_id and p.giver_id = v_me and p.recipient_id = p_friend_id
  ) then
    raise exception 'Чат сбора могут создать только те, кто скидывается';
  end if;

  delete from app.pool_chat_requests r where r.created_at < now() - interval '1 day';
  loop
    v_id := 1 + floor(random() * 2147483646)::integer;
    begin
      insert into app.pool_chat_requests (request_id, room_id, recipient_id, created_by)
      values (v_id, p_room_id, p_friend_id, v_me);
      exit;
    exception when unique_violation then
      -- редкое совпадение — берём другой номер
    end;
  end loop;

  return jsonb_build_object(
    'request_id', v_id,
    'user_id', v_me,
    'friend_name', (select u.first_name from app.users u where u.id = p_friend_id)
  );
end;
$$;

-- Боту пришёл выбранный чат (chat_shared) или /start в группе: чей это сбор.
-- null — запрос чужой, устарел или автор больше не в сборе.
create or replace function app.bot_claim_chat(p_request_id integer, p_from bigint)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_r app.pool_chat_requests;
begin
  select r.* into v_r from app.pool_chat_requests r
  where r.request_id = p_request_id and r.created_at > now() - interval '1 day';
  if v_r.request_id is null or v_r.created_by <> p_from then
    return null;
  end if;
  if not exists (
    select 1 from app.pledges p
    where p.room_id = v_r.room_id and p.giver_id = p_from and p.recipient_id = v_r.recipient_id
  ) then
    return null;
  end if;
  delete from app.pool_chat_requests r where r.request_id = p_request_id;

  return jsonb_build_object(
    'room_id', v_r.room_id,
    'recipient_id', v_r.recipient_id,
    'room_name', (select r.name from app.rooms r where r.id = v_r.room_id),
    'friend_name', (select u.first_name from app.users u where u.id = v_r.recipient_id),
    'creator_name', (select u.first_name from app.users u where u.id = p_from),
    'supporters', coalesce((
      select jsonb_agg(p.giver_id order by p.created_at)
      from app.pledges p
      where p.room_id = v_r.room_id and p.recipient_id = v_r.recipient_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function app.bot_save_chat(
  p_room_id uuid,
  p_recipient_id bigint,
  p_chat_id bigint,
  p_link text,
  p_set_by bigint
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  -- один чат — один сбор
  update app.pool_chats c set chat_id = null
   where c.chat_id = p_chat_id and not (c.room_id = p_room_id and c.recipient_id = p_recipient_id);
  insert into app.pool_chats (room_id, recipient_id, invite_link, set_by, chat_id)
  values (p_room_id, p_recipient_id, p_link, p_set_by, p_chat_id)
  on conflict (room_id, recipient_id) do update
    set invite_link = excluded.invite_link, set_by = excluded.set_by,
        chat_id = excluded.chat_id, updated_at = now();
end;
$$;

-- Пускать ли в чат сбора: только тех, кто сейчас скидывается
create or replace function app.bot_can_join(p_chat_id bigint, p_user_id bigint)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from app.pool_chats c
    join app.pledges p
      on p.room_id = c.room_id and p.recipient_id = c.recipient_id and p.giver_id = p_user_id
    where c.chat_id = p_chat_id
  );
$$;

-- Группа превратилась в супергруппу — у неё новый id
create or replace function app.bot_migrate_chat(p_old_chat_id bigint, p_new_chat_id bigint)
returns void
language sql
volatile
set search_path = ''
as $$
  update app.pool_chats c set chat_id = p_new_chat_id where c.chat_id = p_old_chat_id;
$$;

-- Один раз после развёртывания Edge Function: направить Telegram на вебхук.
--   select app.setup_telegram_webhook('https://<ref>.supabase.co/functions/v1/telegram-bot');
--   select status_code, content::text from net._http_response order by id desc limit 1;
create or replace function app.setup_telegram_webhook(p_url text)
returns bigint
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_token text;
  v_secret text;
begin
  select s.value into v_token from app.settings s where s.key = 'bot_token';
  select s.value into v_secret from app.settings s where s.key = 'webhook_secret';
  if v_token is null then
    raise exception 'Сначала сохраните bot_token в app.settings';
  end if;
  return net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/setWebhook',
    body := jsonb_build_object(
      'url', p_url,
      'secret_token', v_secret,
      'allowed_updates', jsonb_build_array('message', 'chat_join_request')
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Права: снаружи доступны только public.wl_*
-- ---------------------------------------------------------------------------

revoke all on schema app from public, anon, authenticated;
revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'wl\_%'
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated', r.sig);
  end loop;
end;
$$;
