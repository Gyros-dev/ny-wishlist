import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Нижняя шторка. Закрывается тапом по фону и системной кнопкой «Назад». */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40"
        />
      )}
      {open && (
        <motion.div
          key="sheet"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 34, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[92%] overflow-y-auto rounded-t-[22px] bg-bg pb-[calc(env(safe-area-inset-bottom)+20px)]"
          data-sheet
        >
          <div className="sticky top-0 z-10 bg-bg px-5 pt-2.5 pb-2">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-fill" />
            <h2 className="text-center text-[17px] font-semibold">{title}</h2>
          </div>
          <div className="px-4">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
