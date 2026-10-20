import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Периодически вызывает fn, пока вкладка видима, и сразу — при возвращении
 * в приложение. Так шкалы сбора обновляются, когда скидываются другие.
 */
export function usePolling(fn: () => unknown, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') fnRef.current();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs, enabled]);
}
