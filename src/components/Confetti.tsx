import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

const COLORS = ['#f4b13e', '#ff5a6a', '#2fb455', '#4f8ff7', '#c56cf0', '#ffffff'];

interface Piece {
  id: number;
  x: number;
  y: number;
  rotate: number;
  color: string;
  w: number;
  h: number;
  delay: number;
}

function makePieces(): Piece[] {
  return Array.from({ length: 36 }, (_, i) => {
    const angle = (Math.PI * 2 * i) / 36 + Math.random() * 0.4;
    const dist = 110 + Math.random() * 150;
    return {
      id: i,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist - 60,
      rotate: Math.random() * 540 - 270,
      color: COLORS[i % COLORS.length],
      w: 6 + Math.random() * 5,
      h: 9 + Math.random() * 6,
      delay: Math.random() * 0.08,
    };
  });
}

/** Короткий залп конфетти; новый залп — при каждом изменении burst. */
export function Confetti({ burst }: { burst: number }) {
  const [finished, setFinished] = useState(0);
  const pieces = useMemo(() => (burst ? makePieces() : []), [burst]);
  const visible = burst > finished;

  useEffect(() => {
    if (!burst) return;
    const timer = window.setTimeout(() => setFinished(burst), 1800);
    return () => window.clearTimeout(timer);
  }, [burst]);

  return createPortal(
    <AnimatePresence>
      {visible && (
        <div key={burst} className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center">
          {pieces.map((p) => (
            <motion.span
              key={p.id}
              className="absolute rounded-[2px]"
              style={{ width: p.w, height: p.h, background: p.color }}
              initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
              animate={{ x: p.x, y: [0, p.y, p.y + 260], opacity: [1, 1, 0], rotate: p.rotate, scale: 1 }}
              transition={{ duration: 1.6, delay: p.delay, ease: 'easeOut', times: [0, 0.35, 1] }}
            />
          ))}
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
