import { useIsPresent } from 'framer-motion';
import { ImagePlus, Link2, Loader2, Trash2 } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { primeGiftImage, useGiftImage } from '../api/images';
import type { Gift } from '../api/types';
import { AmountInput } from '../components/AmountInput';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { Layer, useMainButton } from '../telegram/buttons';
import { confirmAction, hapticNotification, hapticSelection, openLink } from '../telegram/webapp';
import { GIFT_EMOJIS, guessEmoji } from '../utils/emoji';
import { currencySymbol } from '../utils/format';
import { prepareGiftImage } from '../utils/image';

interface Props {
  roomId: string;
  open: boolean;
  gift: Gift | null;
  onClose: () => void;
  onSaved: (gift: Gift) => void;
  onDeleted: (giftId: string) => void;
}

export function GiftEditor({ roomId, open, gift, onClose, onSaved, onDeleted }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={gift ? 'Подарок' : 'Новый подарок'}>
      <GiftForm key={gift?.id ?? 'new'} roomId={roomId} gift={gift} onSaved={onSaved} onDeleted={onDeleted} />
    </Sheet>
  );
}

function GiftForm({ roomId, gift, onSaved, onDeleted }: Omit<Props, 'open' | 'onClose'>) {
  const isPresent = useIsPresent();
  const [title, setTitle] = useState(gift?.title ?? '');
  const [price, setPrice] = useState(gift?.price ?? 0);
  const [emoji, setEmoji] = useState(gift?.emoji ?? '🎁');
  const [emojiTouched, setEmojiTouched] = useState(!!gift);
  const [link, setLink] = useState(gift?.link ?? '');
  const [saving, setSaving] = useState(false);
  const [shake, setShake] = useState(0);
  // undefined — фото не трогали, null — убрали, строка — новое фото
  const existingPhoto = useGiftImage(gift?.id, gift?.image_rev);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiRowRef = useRef<HTMLDivElement>(null);
  const preview = photo === undefined ? existingPhoto : photo;

  // Подобранный по названию значок может оказаться за краем ряда — докручиваем к нему
  useEffect(() => {
    const row = emojiRowRef.current;
    const button = row?.querySelector<HTMLElement>(`[data-emoji="${emoji}"]`);
    if (!row || !button) return;
    row.scrollTo({ left: button.offsetLeft - (row.clientWidth - button.clientWidth) / 2, behavior: 'smooth' });
  }, [emoji]);

  const pickPhoto = () => fileRef.current?.click();

  // Ссылку можно проверить прямо из редактора; без протокола достраиваем https://,
  // как это делает и база при сохранении
  const linkUrl = (() => {
    const raw = link.trim();
    if (!/^(https?:\/\/)?[^\s/]+\.[^\s]{2,}/i.test(raw)) return null;
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  })();

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProcessing(true);
    try {
      setPhoto(await prepareGiftImage(file));
      hapticSelection();
    } catch (err) {
      hapticNotification('error');
      toast(errorMessage(err), 'error');
    } finally {
      setProcessing(false);
    }
  };

  const onTitle = (value: string) => {
    setTitle(value);
    if (!emojiTouched) setEmoji(guessEmoji(value) ?? '🎁');
  };

  const save = async () => {
    if (!title.trim() || price <= 0) {
      hapticNotification('error');
      setShake((n) => n + 1);
      toast(!title.trim() ? 'Напишите, что хотите получить' : 'Укажите примерную цену', 'error');
      return;
    }
    setSaving(true);
    try {
      let saved = await api.saveGift(roomId, { id: gift?.id ?? null, title, price, emoji, link });
      if (photo !== undefined && (photo || saved.image_rev)) {
        try {
          saved = await api.setGiftImage(saved.id, photo ?? '');
          if (photo && saved.image_rev) primeGiftImage(saved.id, saved.image_rev, photo);
        } catch (err) {
          // Подарок уже сохранён — не держим шторку из-за фото
          toast(`Подарок сохранён, а фото — нет: ${errorMessage(err)}`, 'error');
        }
      }
      hapticNotification('success');
      onSaved(saved);
    } catch (err) {
      hapticNotification('error');
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!gift) return;
    if (!(await confirmAction(`Удалить «${gift.title}» из вишлиста? Голоса друзей за этот подарок пропадут.`))) return;
    try {
      await api.deleteGift(gift.id);
      hapticNotification('warning');
      onDeleted(gift.id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  useMainButton(
    Layer.sheet,
    { text: gift ? 'Сохранить' : 'Добавить в вишлист', onClick: save, loading: saving || processing },
    isPresent,
  );

  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} data-photo-input />
      {preview ? (
        <div className="relative overflow-hidden rounded-[18px] bg-card" data-photo-preview>
          <img src={preview} alt="" className="h-[200px] w-full object-cover" />
          <div className="absolute right-2.5 bottom-2.5 flex gap-2">
            <button
              type="button"
              onClick={pickPhoto}
              className="rounded-full bg-black/55 px-3.5 py-1.5 text-[13px] font-semibold text-white backdrop-blur"
            >
              {processing ? 'Сжимаем…' : 'Заменить'}
            </button>
            <button
              type="button"
              onClick={() => setPhoto(null)}
              className="rounded-full bg-black/55 px-3.5 py-1.5 text-[13px] font-semibold text-white backdrop-blur"
            >
              Убрать
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 pt-1">
          <div className="flex gap-3">
            <div
              key={emoji}
              className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-[20px] bg-card text-[46px]"
            >
              {emoji}
            </div>
            <button
              type="button"
              onClick={pickPhoto}
              disabled={processing}
              data-add-photo
              className="flex h-[84px] flex-1 flex-col items-center justify-center gap-1 rounded-[20px] border-2 border-dashed border-accent/35 bg-accent/6 text-accent"
            >
              {processing ? <Loader2 size={24} className="animate-spin" /> : <ImagePlus size={24} />}
              <span className="text-[14px] font-semibold">{processing ? 'Сжимаем фото…' : 'Добавить фото'}</span>
            </button>
          </div>
          <div ref={emojiRowRef} className="relative -mx-4 overflow-x-auto px-4 py-0.5">
            <div className="flex w-max gap-1.5">
              {GIFT_EMOJIS.map((e) => (
                <button
                  type="button"
                  key={e}
                  data-emoji={e}
                  onClick={() => {
                    hapticSelection();
                    setEmoji(e);
                    setEmojiTouched(true);
                  }}
                  className={`flex h-11 w-11 items-center justify-center rounded-[12px] text-[24px] transition ${
                    e === emoji ? 'bg-accent/15 ring-2 ring-accent ring-inset' : 'bg-card'
                  }`}
                  aria-label={`Значок ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div key={shake} className={shake ? 'animate-[shake_0.35s]' : ''}>
        <div className="overflow-hidden rounded-[14px] bg-card">
          <label className="block px-4 pt-2.5 pb-1">
            <span className="text-[12px] font-medium text-hint">Что подарить</span>
            <input
              name="title"
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              placeholder="Например, наушники"
              maxLength={120}
              autoComplete="off"
              enterKeyHint="next"
              className="block w-full bg-transparent pb-1.5 text-[17px] outline-none placeholder:text-hint/70"
            />
          </label>
          <div className="mx-4 h-px bg-separator" />
          <label className="block px-4 pt-2.5 pb-1">
            <span className="text-[12px] font-medium text-hint">Цена</span>
            <div className="flex items-center pb-1">
              <AmountInput
                name="price"
                value={price}
                onChange={setPrice}
                placeholder="0"
                className="block h-8 w-full bg-transparent text-[17px] leading-8 font-semibold outline-none placeholder:font-normal placeholder:text-hint/70"
              />
              <span className="text-[17px] font-semibold text-hint">{currencySymbol()}</span>
            </div>
          </label>
        </div>
      </div>

      <div className="overflow-hidden rounded-[14px] bg-card">
        <label className="block px-4 pt-2.5 pb-1">
          <span className="flex items-center gap-1 text-[12px] font-medium text-hint">
            <Link2 size={13} /> Ссылка на товар
          </span>
          <div className="flex items-center gap-2">
            <input
              name="link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://… — необязательно"
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              maxLength={500}
              className="block w-full bg-transparent pb-1.5 text-[16px] outline-none placeholder:text-hint/70"
            />
            {linkUrl && (
              <button
                type="button"
                onClick={() => openLink(linkUrl)}
                data-open-link
                className="shrink-0 pb-1.5 text-[14px] font-semibold text-link active:opacity-60"
              >
                Открыть
              </button>
            )}
          </div>
        </label>
      </div>

      {gift ? (
        <button
          type="button"
          onClick={remove}
          className="flex w-full items-center justify-center gap-2 rounded-[14px] bg-card py-3.5 text-[16px] font-medium text-destructive"
        >
          <Trash2 size={18} /> Удалить из вишлиста
        </button>
      ) : (
        <p className="px-2 text-center text-[13px] leading-snug text-hint">
          По цене друзья поймут, хватает ли общего бюджета, а по ссылке — что именно купить
        </p>
      )}
      {/* Enter на клавиатуре отправляет форму */}
      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
    </form>
  );
}
