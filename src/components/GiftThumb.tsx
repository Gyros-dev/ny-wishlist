import type { Gift } from '../api/types';
import { useGiftImage } from '../api/images';

/** Фото подарка, а пока его нет или оно грузится — эмодзи. */
export function GiftThumb({
  gift,
  size,
  radius = 14,
  onOpen,
}: {
  gift: Pick<Gift, 'id' | 'emoji' | 'image_rev'>;
  size: number;
  radius?: number;
  onOpen?: (src: string) => void;
}) {
  const src = useGiftImage(gift.id, gift.image_rev);
  const style = { width: size, height: size, borderRadius: radius };

  if (src) {
    const img = <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />;
    return onOpen ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(src);
        }}
        className="shrink-0 overflow-hidden bg-fill transition active:scale-95"
        style={style}
        aria-label="Открыть фото"
        data-thumb
      >
        {img}
      </button>
    ) : (
      <span className="block shrink-0 overflow-hidden bg-fill" style={style}>
        {img}
      </span>
    );
  }

  return (
    <span
      className="flex shrink-0 items-center justify-center bg-fill"
      style={{ ...style, fontSize: Math.round(size * 0.52) }}
    >
      {gift.emoji}
    </span>
  );
}
