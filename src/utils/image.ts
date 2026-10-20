// Фото с телефона весит мегабайты — перед загрузкой уменьшаем до разумного
// размера и пережимаем в JPEG, чтобы уложиться в лимит базы (~300 КБ).

const MAX_SIDE = 1000;
const MAX_BYTES = 240_000;

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // некоторые WebView не умеют createImageBitmap для части форматов
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareGiftImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Это не похоже на картинку');
  let image;
  try {
    image = await decode(file);
  } catch {
    throw new Error('Не получилось открыть картинку');
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не получилось обработать картинку');

  let side = MAX_SIDE;
  let quality = 0.84;
  for (let attempt = 0; attempt < 7; attempt++) {
    const scale = Math.min(1, side / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    // у PNG с прозрачностью фон в JPEG иначе станет чёрным
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length * 0.75 <= MAX_BYTES) return dataUrl;
    quality = Math.max(0.5, quality - 0.08);
    side = Math.round(side * 0.85);
  }
  throw new Error('Картинка слишком большая — попробуйте другую');
}
