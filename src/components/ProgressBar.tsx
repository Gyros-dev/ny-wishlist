import { motion } from 'framer-motion';

const spring = { type: 'spring', stiffness: 170, damping: 24 } as const;

/**
 * Шкала сбора на подарок в процентах: сплошная часть — то, что собрали
 * другие, штрихованная — ваш вклад (в том числе ещё не сохранённый).
 */
export function ProgressBar({
  othersPct,
  minePct,
  funded,
  height = 10,
}: {
  othersPct: number;
  minePct: number;
  funded: boolean;
  height?: number;
}) {
  const others = Math.max(0, Math.min(100, othersPct));
  const mine = Math.max(0, Math.min(100 - others, minePct));
  const color = funded ? 'var(--success)' : 'var(--accent)';

  return (
    <div
      className="relative w-full overflow-hidden rounded-full bg-fill"
      style={{ height }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(others + mine)}
    >
      <motion.div
        className="absolute inset-y-0 left-0"
        initial={false}
        animate={{ width: `${others}%`, backgroundColor: color }}
        transition={spring}
      />
      <motion.div
        className="stripes absolute inset-y-0"
        initial={false}
        animate={{
          left: `${others}%`,
          width: `${mine}%`,
          backgroundColor: funded
            ? 'color-mix(in srgb, var(--success) 70%, transparent)'
            : 'color-mix(in srgb, var(--accent) 60%, transparent)',
        }}
        transition={spring}
      />
    </div>
  );
}

/** Ряд мини-шкал — по одной на подарок, для карточки участника. */
export function ProgressPills({ progress }: { progress: number[] }) {
  return (
    <div className="flex gap-1">
      {progress.map((pct, i) => (
        <span key={i} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-fill">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${pct >= 100 ? 'bg-success' : 'bg-accent/70'}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      ))}
    </div>
  );
}
