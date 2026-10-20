import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Layer, useBackButton } from '../telegram/buttons';

/** Фото подарка на весь экран. Закрывается тапом и кнопкой «Назад». */
export function Lightbox({ src, caption, onClose }: { src: string | null; caption?: string; onClose: () => void }) {
  useBackButton(Layer.sheet, src ? onClose : null);

  return createPortal(
    <AnimatePresence>
      {src && (
        <motion.div
          key="lightbox"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[65] flex flex-col items-center justify-center bg-black/88 px-4 pt-[var(--inset-top)] pb-[var(--inset-bottom)]"
          data-lightbox
        >
          <motion.img
            src={src}
            alt=""
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="max-h-[78%] w-full rounded-[18px] object-contain"
          />
          {caption && <p className="mt-4 text-center text-[16px] font-medium text-white">{caption}</p>}
          <p className="mt-2 text-[13px] text-white/50">Нажмите, чтобы закрыть</p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
