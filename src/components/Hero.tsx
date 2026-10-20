import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import { newYearCountdown, plural } from '../utils/format';

function Snow({ count = 22 }: { count?: number }) {
  // Детерминированная «случайность», чтобы снег не прыгал при перерисовке
  const flakes = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const r = (n: number) => ((Math.sin(i * 97.13 + n * 13.7) + 1) / 2) % 1;
        return {
          left: `${r(1) * 100}%`,
          size: 2 + r(2) * 3.5,
          duration: 5 + r(3) * 6,
          delay: -r(4) * 10,
          opacity: 0.5 + r(5) * 0.5,
        };
      }),
    [count],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {flakes.map((f, i) => (
        <span
          key={i}
          className="snowflake"
          style={{
            left: f.left,
            width: f.size,
            height: f.size,
            opacity: f.opacity,
            animationDuration: `${f.duration}s`,
            animationDelay: `${f.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Праздничная шапка. С title/onTitleClick — шапка компании: название
 * открывает список компаний, приглашение и настройки.
 */
export function Hero({
  title = 'Вишлист',
  subtitle,
  onTitleClick,
}: {
  title?: string;
  subtitle: string;
  onTitleClick?: () => void;
}) {
  const { year, days, celebrating } = newYearCountdown();
  return (
    <div className="hero relative overflow-hidden rounded-[22px] px-5 pt-5 pb-5 text-white shadow-[0_10px_30px_-12px_rgba(59,42,143,0.6)]">
      <Snow />
      <div className="relative flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold tracking-[0.12em] text-white/70 uppercase">
            Новый год {year}
          </div>
          {onTitleClick ? (
            <button
              onClick={onTitleClick}
              data-room-switch
              className="mt-1 flex max-w-full items-center gap-1 text-left transition active:opacity-70"
            >
              <span className="line-clamp-2 text-[22px] leading-tight font-bold">{title}</span>
              <ChevronDown size={22} className="shrink-0 self-end text-white/80" />
            </button>
          ) : (
            <h1 className="mt-1 text-[26px] leading-tight font-bold">{title}</h1>
          )}
          <p className="mt-1 text-[14px] leading-snug text-white/80">{subtitle}</p>
        </div>
        <div className="flex h-[84px] w-[84px] shrink-0 flex-col items-center justify-center rounded-[20px] bg-white/14 ring-1 ring-white/25 backdrop-blur-sm">
          {celebrating ? (
            <span className="text-[38px]">🎉</span>
          ) : (
            <>
              <span className="tabular text-[30px] leading-none font-bold">{days}</span>
              <span className="mt-1 text-[11px] leading-tight text-white/80">
                {plural(days, ['день', 'дня', 'дней'])}
                <br />
                до праздника
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
