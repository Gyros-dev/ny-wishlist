// Эмулятор клиента Telegram для разработки и видео-демо.
//
// Мини-приложение открывается в iframe ровно так, как его открывает
// web.telegram.org: initData и тема передаются в hash (#tgWebAppData=...),
// а telegram-web-app.js внутри iframe шлёт сюда события postMessage
// (web_app_setup_main_button, web_app_open_popup, ...). Эмулятор рисует
// шапку, MainButton и системные алерты и отвечает событиями
// main_button_pressed, back_button_pressed, popup_closed и т. д.

const params = new URLSearchParams(location.search);
const API = params.get('api') ?? 'http://localhost:54321';
const demo = params.has('demo');
// Полноэкранный режим Telegram (Bot API 8.0): без шапки, с плавающими кнопками
const fullscreen = params.has('fullscreen');
// &nopm=1 — пользователи ещё не разрешали боту писать им в личку
const noPm = params.has('nopm');
// Отступы, которые iOS-клиент сообщает в полноэкранном режиме
const FULLSCREEN_SAFE_AREA = { top: 50, bottom: 0, left: 0, right: 0 };
const FULLSCREEN_CONTENT_SAFE_AREA = { top: 46, bottom: 0, left: 0, right: 0 };
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
document.body.classList.toggle('demo', demo);

const THEMES = {
  light: {
    bg_color: '#ffffff',
    secondary_bg_color: '#efeff4',
    section_bg_color: '#ffffff',
    text_color: '#000000',
    hint_color: '#8e8e93',
    link_color: '#007aff',
    button_color: '#007aff',
    button_text_color: '#ffffff',
    accent_text_color: '#007aff',
    section_header_text_color: '#6d6d72',
    subtitle_text_color: '#8e8e93',
    destructive_text_color: '#ff3b30',
    header_bg_color: '#f8f8f8',
    bottom_bar_bg_color: '#f2f2f7',
    section_separator_color: '#c8c7cc',
  },
  dark: {
    bg_color: '#1c1c1e',
    secondary_bg_color: '#000000',
    section_bg_color: '#1c1c1e',
    text_color: '#ffffff',
    hint_color: '#98989e',
    link_color: '#3e88f7',
    button_color: '#3e88f7',
    button_text_color: '#ffffff',
    accent_text_color: '#3e88f7',
    section_header_text_color: '#8d8e93',
    subtitle_text_color: '#98989e',
    destructive_text_color: '#eb5545',
    header_bg_color: '#1a1a1a',
    bottom_bar_bg_color: '#1d1d1d',
    section_separator_color: '#38383a',
  },
};

const LABELS = {
  1005: 'получит приглашение',
  1004: 'зовёт друга в компанию',
};

// Переписка, с которой начинается телефон в режиме chat
const CHAT_HISTORY = [
  { dir: 'in', text: 'Привет! Что тебе подарить на Новый год? 🎄', time: '20:58' },
  { dir: 'out', text: 'Ой, даже не знаю 😅', time: '20:59' },
];

const AVATAR_COLORS = [
  ['#ff885e', '#ff516a'],
  ['#ffcd6a', '#ffa85c'],
  ['#82b1ff', '#665fff'],
  ['#a0de7e', '#54cb68'],
  ['#53edd6', '#28c9b7'],
  ['#72d5fd', '#2a9ef1'],
  ['#e0a2f3', '#d669ed'],
];

const ICONS = `
  <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
  <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3C13.3 1.5 10.8.4 8 .4S2.7 1.5.8 3.3L2 4.6c1.6-1.5 3.7-2.4 6-2.4Zm0 3.5c1.3 0 2.5.5 3.5 1.3l1.2-1.3C11.4 4.6 9.8 3.9 8 3.9s-3.4.7-4.7 1.8L4.5 7c1-.8 2.2-1.3 3.5-1.3Zm0 3.4c-.6 0-1.2.2-1.6.6L8 11.6l1.6-1.9c-.4-.4-1-.6-1.6-.6Z"/></svg>
  <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.5-1.1 1.5-2s-.7-1.7-1.5-2Z" fill="currentColor" opacity=".5"/></svg>`;

const CHEVRON = `<svg width="12" height="20" viewBox="0 0 12 20" fill="none"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function snow() {
  const sky = document.getElementById('sky');
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('span');
    const size = 1.5 + Math.random() * 3.5;
    Object.assign(s.style, {
      left: `${Math.random() * 100}%`,
      width: `${size}px`,
      height: `${size}px`,
      opacity: String(0.15 + Math.random() * 0.45),
      animationDuration: `${12 + Math.random() * 16}s`,
      animationDelay: `${-Math.random() * 28}s`,
    });
    sky.appendChild(s);
  }
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function clock() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

class Phone {
  constructor(spec, personas) {
    this.userId = spec.id;
    this.themeName = spec.theme;
    this.mode = spec.mode;
    this.personas = personas;
    this.persona = personas.find((p) => String(p.id) === String(spec.id));
    this.backVisible = false;
    this.mainParams = { is_visible: false };
    this.popupCallback = null;
    this.ready = false;
    this.build(personas);
    this.applyTheme();
  }

  get theme() {
    return THEMES[this.themeName];
  }

  build(personas) {
    const [from, to] = AVATAR_COLORS[Number(this.userId) % AVATAR_COLORS.length];
    const p = this.persona;
    this.root = el(`
      <div class="phone" id="phone-${this.userId}">
        <div class="phone-label">
          <span class="dot" style="background:linear-gradient(180deg,${from},${to})">${p.first_name[0]}${p.last_name?.[0] ?? ''}</span>
          ${p.first_name}${LABELS[this.userId] && demo ? ` <small>${LABELS[this.userId]}</small>` : ''}
        </div>
        <div class="phone-tools">
          <select class="persona">${personas
            .map((x) => `<option value="${x.id}" ${String(x.id) === String(this.userId) ? 'selected' : ''}>${x.first_name} ${x.last_name ?? ''}</option>`)
            .join('')}</select>
          <button class="theme">Тема</button>
          <button class="reload">↻</button>
        </div>
        <div class="device"><div class="screen">
          <div class="statusbar"><span class="time">${clock()}</span><span class="island"></span><span class="icons">${ICONS}</span></div>
          <div class="tg-header">
            <button class="tg-left">${CHEVRON}<span>Закрыть</span></button>
            <div class="tg-title"><b>Вишлист 2027</b><small>мини-приложение</small></div>
            <span class="tg-menu">···</span>
          </div>
          <div class="fs-controls">
            <button class="fs-pill fs-left">✕ <span>Закрыть</span></button>
            <span class="fs-pill">⌄&nbsp;&nbsp;···</span>
          </div>
          <div class="viewport">
            <div class="splash">🎁</div>
            <iframe title="mini app" allow="clipboard-write"></iframe>
            <div class="popup-layer"></div>
            <div class="tg-toast"></div>
          </div>
          <div class="bottom-bar"><button class="main-button"><span class="label"></span><span class="spinner"></span></button></div>
          <div class="home-zone"></div>
          <div class="chat-layer">
            <div class="chat-head">
              <span class="chat-back">${CHEVRON}</span>
              <div class="chat-peer"><b></b><small>в сети</small></div>
              <span class="dot chat-avatar"></span>
            </div>
            <div class="chat-body"></div>
            <div class="chat-input"><span>📎</span><span class="field">Сообщение</span><span>🎙</span></div>
          </div>
        </div></div>
      </div>`);
    this.screen = this.root.querySelector('.screen');
    this.iframe = this.root.querySelector('iframe');
    this.splash = this.root.querySelector('.splash');
    this.left = this.root.querySelector('.tg-left');
    this.fsLeft = this.root.querySelector('.fs-left');
    this.screen.classList.toggle('fullscreen', fullscreen);
    this.fsLeft.addEventListener('click', () => {
      if (this.backVisible) this.post('back_button_pressed');
      else this.load();
    });
    this.bottomBar = this.root.querySelector('.bottom-bar');
    this.mainButton = this.root.querySelector('.main-button');
    this.popupLayer = this.root.querySelector('.popup-layer');
    this.toastEl = this.root.querySelector('.tg-toast');
    this.chatLayer = this.root.querySelector('.chat-layer');
    this.chatBody = this.root.querySelector('.chat-body');

    this.left.addEventListener('click', () => {
      if (this.backVisible) this.post('back_button_pressed');
      else this.load();
    });
    this.mainButton.addEventListener('click', () => {
      if (this.mainParams.is_visible && this.mainParams.is_active !== false) this.post('main_button_pressed');
    });
    this.bottomBar.addEventListener('transitionend', () => this.sendViewport());
    this.root.querySelector('.reload').addEventListener('click', () => this.load());
    this.root.querySelector('.theme').addEventListener('click', () => {
      this.themeName = this.themeName === 'light' ? 'dark' : 'light';
      this.applyTheme();
      this.post('theme_changed', { theme_params: this.theme });
    });
    this.root.querySelector('.persona').addEventListener('change', (e) => {
      const url = new URL(location.href);
      const specs = phoneSpecs.map((s) => (s.id === this.userId ? `${e.target.value}:${s.theme}` : `${s.id}:${s.theme}`));
      url.searchParams.set('phones', specs.join(','));
      location.href = url.toString();
    });
    setInterval(() => (this.root.querySelector('.time').textContent = clock()), 15000);
  }

  applyTheme(header = this.theme.secondary_bg_color, bg = this.theme.secondary_bg_color, bottom = this.theme.secondary_bg_color) {
    const t = this.theme;
    const s = this.screen.style;
    s.setProperty('--bg', bg);
    s.setProperty('--header', header);
    s.setProperty('--bottom', bottom);
    s.setProperty('--text', t.text_color);
    s.setProperty('--hint', t.hint_color);
    s.setProperty('--link', t.link_color);
    s.setProperty('--card', t.section_bg_color);
    s.setProperty('--separator', t.section_separator_color);
    s.setProperty('--fill', this.themeName === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)');
    this.screen.classList.toggle('dark-chat', this.themeName === 'dark');
  }

  resolveColor(data) {
    if (data?.color_key) return this.theme[data.color_key];
    if (data?.color && this.theme[data.color]) return this.theme[data.color];
    return data?.color;
  }

  /** Экран переписки в Telegram — пока мини-приложение не открыто. */
  openChat(peer) {
    const [from, to] = AVATAR_COLORS[Number(peer.id) % AVATAR_COLORS.length];
    this.chatPeer = peer;
    this.chatLayer.querySelector('.chat-peer b').textContent = `${peer.first_name} ${peer.last_name ?? ''}`;
    const avatar = this.chatLayer.querySelector('.chat-avatar');
    avatar.textContent = `${peer.first_name[0]}${peer.last_name?.[0] ?? ''}`;
    avatar.style.background = `linear-gradient(180deg,${from},${to})`;
    this.chatBody.innerHTML = '';
    CHAT_HISTORY.forEach((m) => this.addMessage(m));
    this.chatLayer.classList.add('open');
    this.splash.classList.add('gone');
  }

  addMessage({ dir, text, time, invite }) {
    const bubble = el(`<div class="bubble ${dir}"><div class="text"></div><span class="time">${time ?? clock()}</span></div>`);
    bubble.querySelector('.text').textContent = text;
    if (invite) {
      bubble.classList.add('invite');
      const link = el(`<div class="link"></div>`);
      link.textContent = invite.url;
      const preview = el(`
        <div class="preview">
          <b>Вишлист 2027</b>
          <span>Мини-приложение · подарки на Новый год вместе</span>
          <button class="open-app" data-open-invite>Открыть вишлист</button>
        </div>`);
      preview.querySelector('button').addEventListener('click', () => {
        this.chatLayer.classList.remove('open');
        this.load(invite.startParam);
      });
      bubble.insertBefore(link, bubble.querySelector('.time'));
      bubble.insertBefore(preview, bubble.querySelector('.time'));
    }
    this.chatBody.appendChild(bubble);
    setTimeout(() => bubble.classList.add('shown'), 30);
  }

  /** WebApp.requestChat: в Telegram здесь системный выбор чата, эмулятор сразу «создаёт» новый */
  async simulateRequestChat(buttonId) {
    this.toast('💬 Telegram: создан чат «Сбор на подарок»');
    try {
      const res = await fetch(`${API}/__dev/request-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ button_id: buttonId, title: 'Сбор на подарок' }),
      });
      if (!res.ok) throw new Error(await res.text());
      this.post('requested_chat_sent', {});
    } catch (err) {
      this.post('requested_chat_failed', { error: String(err) });
    }
  }

  /** Другой телефон «поделился» ссылкой через t.me/share/url */
  receiveShare(fromPhone, url, text) {
    let startParam = null;
    try {
      startParam = new URL(url).searchParams.get('startapp');
    } catch {
      // не ссылка на мини-приложение
    }
    if (!this.chatLayer.classList.contains('open') || this.chatPeer?.id !== fromPhone.persona.id) {
      this.openChat(fromPhone.persona);
    }
    this.addMessage({ dir: 'in', text, invite: { url, startParam } });
  }

  async load(startParam = null) {
    this.ready = false;
    this.splash.classList.remove('gone');
    this.setMainButton({ is_visible: false });
    this.setBack(false);
    const res = await fetch(
      `${API}/__dev/init-data?user=${this.userId}${startParam ? `&start=${encodeURIComponent(startParam)}` : ''}${noPm ? '&pm=0' : ''}`,
    );
    const { initData } = await res.json();
    const hash = new URLSearchParams({
      tgWebAppData: initData,
      tgWebAppVersion: '9.6',
      tgWebAppPlatform: 'ios',
      tgWebAppThemeParams: JSON.stringify(this.theme),
      ...(fullscreen ? { tgWebAppFullscreen: '1' } : {}),
    });
    // ?u= — чтобы у каждого телефона был свой URL и браузер не путал iframe
    this.iframe.src = `/?u=${this.userId}&t=${Date.now()}#${hash.toString()}`;
    this.loaded = new Promise((resolve) => (this.resolveLoaded = resolve));
    return this.loaded;
  }

  post(eventType, eventData) {
    this.iframe.contentWindow?.postMessage(JSON.stringify({ eventType, eventData }), '*');
  }

  sendViewport() {
    const h = this.iframe.clientHeight;
    this.post('viewport_changed', { height: h, width: this.iframe.clientWidth, is_expanded: true, is_state_stable: true });
  }

  setBack(visible) {
    this.backVisible = visible;
    this.left.classList.toggle('back', visible);
    this.left.querySelector('span').textContent = visible ? 'Назад' : 'Закрыть';
    this.fsLeft.innerHTML = visible ? '‹ <span>Назад</span>' : '✕ <span>Закрыть</span>';
  }

  setMainButton(p) {
    this.mainParams = p;
    const visible = !!p.is_visible;
    this.bottomBar.classList.toggle('visible', visible);
    if (!visible) return;
    this.mainButton.querySelector('.label').textContent = p.text ?? '';
    this.mainButton.style.background = p.color || this.theme.button_color;
    this.mainButton.style.color = p.text_color || this.theme.button_text_color;
    this.mainButton.disabled = p.is_active === false;
    this.mainButton.classList.toggle('progress', !!p.is_progress_visible);
    this.mainButton.classList.toggle('shine', !!p.has_shine_effect);
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2400);
  }

  openPopup({ title, message, buttons = [{ id: '', type: 'close' }] }) {
    const label = (b) => b.text || { ok: 'OK', close: 'Закрыть', cancel: 'Отмена' }[b.type] || 'OK';
    const alert = el(`
      <div class="alert">
        <div class="body">${title ? `<div class="title"></div>` : ''}<div class="message"></div></div>
        <div class="buttons ${buttons.length > 2 ? 'stacked' : ''}"></div>
      </div>`);
    if (title) alert.querySelector('.title').textContent = title;
    alert.querySelector('.message').textContent = message;
    // Как в iOS: «Отмена» слева
    const ordered = [...buttons].sort((a, b) => (a.type === 'cancel' ? -1 : b.type === 'cancel' ? 1 : 0));
    for (const b of ordered) {
      const btn = document.createElement('button');
      btn.textContent = label(b);
      btn.className = b.type;
      btn.dataset.buttonId = b.id ?? '';
      btn.addEventListener('click', () => {
        this.popupLayer.classList.remove('open');
        this.popupLayer.innerHTML = '';
        this.post('popup_closed', { button_id: b.id ?? '' });
      });
      alert.querySelector('.buttons').appendChild(btn);
    }
    this.popupLayer.innerHTML = '';
    this.popupLayer.appendChild(alert);
    this.popupLayer.classList.add('open');
  }

  onEvent(type, data) {
    switch (type) {
      case 'web_app_ready':
        this.ready = true;
        this.splash.classList.add('gone');
        this.resolveLoaded?.();
        break;
      case 'web_app_request_theme':
        this.post('theme_changed', { theme_params: this.theme });
        break;
      case 'web_app_request_viewport':
        this.sendViewport();
        break;
      case 'web_app_request_safe_area':
        this.post('safe_area_changed', fullscreen ? FULLSCREEN_SAFE_AREA : ZERO_INSETS);
        break;
      case 'web_app_request_content_safe_area':
        this.post('content_safe_area_changed', fullscreen ? FULLSCREEN_CONTENT_SAFE_AREA : ZERO_INSETS);
        break;
      case 'web_app_setup_main_button':
        this.setMainButton(data);
        break;
      case 'web_app_setup_back_button':
        this.setBack(!!data.is_visible);
        break;
      case 'web_app_set_header_color':
        this.screen.style.setProperty('--header', this.resolveColor(data));
        break;
      case 'web_app_set_background_color':
        this.screen.style.setProperty('--bg', this.resolveColor(data));
        break;
      case 'web_app_set_bottom_bar_color':
        this.screen.style.setProperty('--bottom', this.resolveColor(data));
        break;
      case 'web_app_open_popup':
        this.openPopup(data);
        break;
      case 'web_app_open_tg_link': {
        if (data.path_full?.startsWith('/share/url')) {
          // «Отправляем» ссылку на соседний телефон, как будто выбрали его чат
          const q = new URLSearchParams(data.path_full.split('?')[1] ?? '');
          const target = Object.values(phones).find((p) => p !== this);
          if (target) {
            target.receiveShare(this, q.get('url') ?? '', q.get('text') ?? '');
            this.toast(`📨 Отправлено: ${target.persona.first_name} ${target.persona.last_name ?? ''}`);
          } else {
            this.toast('📨 Telegram предложит выбрать чат для ссылки');
          }
        } else {
          this.toast(`↗ t.me${data.path_full}`);
        }
        break;
      }
      case 'web_app_open_link':
        this.toast(`🌐 Откроется ${new URL(data.url).hostname}`);
        break;
      case 'web_app_request_chat':
        void this.simulateRequestChat(data.req_id);
        break;
      case 'web_app_request_write_access':
        this.post('write_access_requested', { status: 'allowed' });
        break;
      case 'web_app_close':
        this.load();
        break;
      default:
        break;
    }
  }
}

// ---------- запуск ----------

// ?phones=1005:light:chat,1004:dark — id:тема[:chat|start_param]
const phoneSpecs = (params.get('phones') ?? '1005:light,1004:dark').split(',').map((s) => {
  const [id, theme = 'light', mode = ''] = s.split(':');
  return { id, theme: THEMES[theme] ? theme : 'light', mode };
});

const phones = {};

window.addEventListener('message', (e) => {
  const phone = Object.values(phones).find((p) => p.iframe.contentWindow === e.source);
  if (!phone || typeof e.data !== 'string') return;
  let msg;
  try {
    msg = JSON.parse(e.data);
  } catch {
    return;
  }
  phone.onEvent(msg.eventType, msg.eventData ?? {});
});

document.getElementById('reset').addEventListener('click', async () => {
  await fetch(`${API}/__dev/reset`, { method: 'POST' });
  Object.values(phones).forEach((p) => p.load());
});

// ---------- сценарий видео ----------

const STEPS = [
  ['Создаёте компанию и зовёте друзей', 'По ссылке-приглашению — вишлисты видят только свои'],
  ['Собираете свой вишлист', 'Вставили ссылку — название, цена и фото подтянутся сами'],
  ['Выбираете друга', 'Видно, на сколько подарков уже хватает и сколько не хватает'],
  ['Указываете свою сумму', 'Её не видит никто — ни друг, ни другие участники'],
  ['Голосуете за подарки', 'Можно за несколько — если денег хватает на всё сразу'],
  ['Решаете, кто покупает', 'Участники сбора видят друг друга, после покупки сбор закрыт'],
  ['Тайный Санта', 'Бот разыгрывает пары — каждый знает только свою'],
  ['Дни рождения', 'У каждого свой праздник — бот напомнит друзьям заранее'],
];

function renderSteps(active = -1) {
  const list = document.getElementById('steps');
  list.innerHTML = '';
  STEPS.forEach(([t, d], i) => {
    const li = el(`<li><span class="num">${i < active ? '✓' : i + 1}</span><div><div class="t"></div><div class="d"></div></div></li>`);
    li.querySelector('.t').textContent = t;
    li.querySelector('.d').textContent = d;
    if (i < active) li.classList.add('done');
    if (i === active) li.classList.add('active');
    list.appendChild(li);
  });
}

const finger = document.getElementById('finger');
const say = document.getElementById('say');

window.emu = {
  phones,
  step: (i) => renderSteps(i),
  say(text) {
    say.classList.add('hidden');
    setTimeout(() => {
      say.textContent = text ?? '';
      say.classList.toggle('hidden', !text);
    }, 250);
  },
  move(x, y) {
    finger.style.transform = `translate(${x}px, ${y}px)`;
    finger.classList.add('visible');
  },
  press(down) {
    finger.classList.toggle('press', down);
    if (down) {
      const r = document.createElement('div');
      r.className = 'ripple';
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(finger.style.transform);
      if (m) Object.assign(r.style, { left: `${m[1]}px`, top: `${m[2]}px` });
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }
  },
  hideFinger: () => finger.classList.remove('visible'),
  outro: (show = true) => document.getElementById('outro').classList.toggle('show', show),
};

async function main() {
  snow();
  renderSteps(-1);
  const personas = await (await fetch(`${API}/__dev/personas`)).json();
  const container = document.getElementById('phones');
  for (const spec of phoneSpecs) {
    const phone = new Phone(spec, personas);
    phones[spec.id] = phone;
    container.appendChild(phone.root);
  }
  // Подгоняем сцену под окно меньше 1080p
  const fit = () => {
    const scale = Math.min(1, (innerHeight - 40) / 930, (innerWidth - (demo ? 900 : 40)) / container.scrollWidth);
    container.style.zoom = String(Math.max(0.4, scale));
  };
  fit();
  addEventListener('resize', fit);
  window.emu.ready = Promise.all(
    Object.values(phones).map((p) => {
      if (p.mode === 'chat') {
        const peer = Object.values(phones).find((x) => x !== p)?.persona ?? p.persona;
        p.openChat(peer);
        return Promise.resolve();
      }
      return p.load(p.mode || null);
    }),
  );
}

window.emu.started = main();
