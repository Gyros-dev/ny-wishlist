import { useLayoutEffect, useRef } from 'react';
import { supportsBackButton, tg } from './webapp';

// MainButton и BackButton у Telegram одни на всё приложение, а хотят ими
// управлять несколько экранов сразу (список, открытый друг, шторка поверх).
// Каждый экран регистрируется со своим слоем, и кнопкой распоряжается самый
// верхний из участвующих: шторка (2) поверх друга (1) поверх главного
// экрана (0). Экран, который уже закрывается (анимация выхода), перестаёт
// участвовать — и кнопка сразу возвращается к тому, что под ним.

export const Layer = { home: 0, friend: 1, sheet: 2 } as const;

interface Entry<T> {
  id: number;
  layer: number;
  active: boolean;
  value: T | null;
}

function createStack<T>(apply: (top: T | null) => void) {
  const entries: Entry<T>[] = [];
  let seq = 0;
  const top = () => {
    let best: Entry<T> | null = null;
    for (const e of entries) {
      if (!e.active) continue;
      if (!best || e.layer > best.layer || (e.layer === best.layer && e.id > best.id)) best = e;
    }
    return best?.value ?? null;
  };
  return {
    top,
    push(layer: number): Entry<T> {
      const entry: Entry<T> = { id: ++seq, layer, active: false, value: null };
      entries.push(entry);
      return entry;
    },
    update(entry: Entry<T>, value: T | null, active: boolean) {
      entry.value = value;
      entry.active = active;
      apply(top());
    },
    remove(entry: Entry<T>) {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      apply(top());
    },
  };
}

// --- MainButton --------------------------------------------------------------

interface MainButtonState {
  text: string;
  loading: boolean;
  disabled: boolean;
  shine: boolean;
  onClick: () => void;
}

const mainStack = createStack<MainButtonState>((top) => {
  const mb = tg?.MainButton;
  if (!mb) return;
  try {
    if (!top) {
      mb.hideProgress();
      mb.setParams({ is_visible: false });
      return;
    }
    mb.setParams({
      text: top.text,
      is_visible: true,
      is_active: !top.disabled,
      has_shine_effect: top.shine,
    });
    if (top.loading) mb.showProgress(false);
    else mb.hideProgress();
  } catch {
    // старый клиент без части параметров
  }
});

let mainClickBound = false;
function bindMainClick() {
  if (mainClickBound || !tg?.MainButton) return;
  mainClickBound = true;
  tg.MainButton.onClick(() => {
    const top = mainStack.top();
    if (top && !top.loading && !top.disabled) top.onClick();
  });
}

export interface MainButtonConfig {
  text: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  shine?: boolean;
}

/**
 * config null — экран хочет, чтобы кнопки не было. active false — экран
 * не претендует на кнопку (закрыт или закрывается).
 */
export function useMainButton(layer: number, config: MainButtonConfig | null, active = true) {
  const entryRef = useRef<Entry<MainButtonState> | null>(null);
  const clickRef = useRef(config?.onClick);
  useLayoutEffect(() => {
    clickRef.current = config?.onClick;
  });

  useLayoutEffect(() => {
    bindMainClick();
    const entry = mainStack.push(layer);
    entryRef.current = entry;
    return () => mainStack.remove(entry);
  }, [layer]);

  const visible = config !== null;
  const text = config?.text ?? '';
  const loading = !!config?.loading;
  const disabled = !!config?.disabled;
  const shine = !!config?.shine;

  useLayoutEffect(() => {
    if (!entryRef.current) return;
    mainStack.update(
      entryRef.current,
      visible ? { text, loading, disabled, shine, onClick: () => clickRef.current?.() } : null,
      active,
    );
  }, [visible, text, loading, disabled, shine, layer, active]);
}

// --- BackButton --------------------------------------------------------------

const backStack = createStack<() => void>((top) => {
  if (!tg || !supportsBackButton()) return;
  try {
    if (top) tg.BackButton.show();
    else tg.BackButton.hide();
  } catch {
    // нет кнопки «Назад» в этом клиенте
  }
});

let backClickBound = false;
function bindBackClick() {
  if (backClickBound || !tg || !supportsBackButton()) return;
  backClickBound = true;
  tg.BackButton.onClick(() => backStack.top()?.());
}

/** Показывает «Назад», пока экран открыт и handler не null. */
export function useBackButton(layer: number, handler: (() => void) | null) {
  const entryRef = useRef<Entry<() => void> | null>(null);
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  const active = handler !== null;

  useLayoutEffect(() => {
    bindBackClick();
    const entry = backStack.push(layer);
    entryRef.current = entry;
    return () => backStack.remove(entry);
  }, [layer]);

  useLayoutEffect(() => {
    if (!entryRef.current) return;
    backStack.update(entryRef.current, active ? () => handlerRef.current?.() : null, active);
  }, [active, layer]);
}
