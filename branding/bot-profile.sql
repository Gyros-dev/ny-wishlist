-- Имя и описания бота. Выполнить в Supabase SQL Editor: запросы к Bot API
-- уходят через pg_net, токен берётся из app.settings и наружу не попадает.
-- Аватар и картинку описания ставит только @BotFather: /setuserpic →
-- branding/bot-avatar.png, /setdescriptionpic → branding/bot-description.png.
select m.method, net.http_post(
  url := 'https://api.telegram.org/bot' || (select s.value from app.settings s where s.key = 'bot_token') || '/' || m.method,
  body := m.body,
  headers := '{"Content-Type": "application/json"}'::jsonb
) as request_id
from (values
  -- имя в списке чатов и в шапке мини-приложения, до 64 символов
  ('setMyName', jsonb_build_object('name', 'Вишлист — подарки в складчину')),
  -- «О боте» в профиле и в ссылке на бота, до 120 символов
  ('setMyShortDescription', jsonb_build_object('short_description',
    'Вишлисты на Новый год и дни рождения. Скидывайтесь на подарки вместе — кто сколько вложил, не видит никто')),
  -- «Что умеет этот бот?» в пустом чате до /start, до 512 символов
  ('setMyDescription', jsonb_build_object('description',
'🎁 Вишлисты для друзей, семьи и коллег.

• Создайте компанию и позовите своих по ссылке
• Добавляйте подарки — по ссылке на товар название, цена и фото подставятся сами
• Скидывайтесь вместе: видно, на сколько подарков уже хватает, а кто сколько вложил — не видит никто
• Голосуйте за подарки, договоритесь, кто покупает, — каждый видит свою часть
• 🎄 Новый год с Тайным Сантой и 🎂 дни рождения с напоминаниями

Нажмите «Открыть», чтобы начать'))
) as m(method, body);

-- Через пару секунд проверить: три ответа {"ok":true,"result":true}
select id, status_code, content::text from net._http_response order by id desc limit 3;
