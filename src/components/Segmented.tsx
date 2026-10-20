import { motion } from 'framer-motion';
import { hapticSelection } from '../telegram/webapp';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; badge?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-[12px] bg-fill p-[3px]" role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            data-tab={o.value}
            onClick={() => {
              if (!active) {
                hapticSelection();
                onChange(o.value);
              }
            }}
            className="relative flex-1 rounded-[9px] py-[7px] text-[14px] font-semibold"
          >
            {active && (
              <motion.span
                layoutId="segmented-pill"
                className="absolute inset-0 rounded-[9px] bg-card shadow-[0_1px_4px_rgba(0,0,0,0.12)]"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className={`relative ${active ? 'text-text' : 'text-hint'}`}>
              {o.label}
              {o.badge ? <span className="tabular ml-1.5 text-hint">{o.badge}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
