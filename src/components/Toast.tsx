import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';

type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

let seq = 0;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(text: string, kind: ToastKind = 'info') {
  const item = { id: ++seq, text, kind };
  listeners.forEach((l) => l(item));
}

export function Toaster() {
  const [item, setItem] = useState<ToastItem | null>(null);

  useEffect(() => {
    const onToast = (t: ToastItem) => setItem(t);
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => setItem(null), item.kind === 'error' ? 3800 : 2600);
    return () => window.clearTimeout(timer);
  }, [item]);

  const icon = item?.kind === 'success' ? '✓' : item?.kind === 'error' ? '!' : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--inset-top)+12px)] z-[60] flex justify-center px-4">
      <AnimatePresence>
        {item && (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="flex max-w-sm items-center gap-2.5 rounded-2xl bg-[#1c1c1e]/92 px-4 py-3 text-[15px] leading-snug text-white shadow-lg backdrop-blur"
            role="status"
          >
            {icon && (
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
                  item.kind === 'success' ? 'bg-success' : 'bg-destructive'
                }`}
              >
                {icon}
              </span>
            )}
            <span>{item.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
