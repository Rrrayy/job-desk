/**
 * 照片处理（PRD §8.3 / ARCH Q8）：读取即压缩，宽 ≤480px、单张 ≤80 KB。
 *
 * 为什么必须在**写入前**压缩，而不是存原图再显示时缩：
 * 1. 整个库存在 localStorage 里（配额 ~5 MB），一张手机原图 3–5 MB 就能把库挤爆，
 *    而爆掉的表现是「保存简历失败」—— 用户完全无法把这个现象和「我刚才传了张照片」联系起来；
 * 2. 照片只用于 A4 打印，480px 宽在 300dpi 下的 A4 里已经超过 5cm 的实际印刷宽度，
 *    再大也看不出来。
 *
 * 失败一律返回 `{ ok:false, reason }` 而不是抛错：调用方是表单里的一行提示，
 * 不是错误边界（R-AI-5 同款口径：失败要说人话，不弹窗）。
 *
 * ★ 纯计算与副作用分离：`byteSizeOf` / `fitWithin` 是纯函数（node 里可测），
 *   `compressPhoto` 才碰 canvas —— 所以「压缩逻辑」的边界条件不依赖 jsdom 有没有 canvas。
 */

/** 压缩结果：成功带 data URL 与实际字节数，失败带可读原因（不抛错） */
export type PhotoHandle =
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: string };

/** 照片最大宽度（px）：A4 上 ~5cm 宽、300dpi 已经够用 */
export const PHOTO_MAX_WIDTH = 480;

/** 单张照片上限（字节）：80 KB */
export const PHOTO_MAX_BYTES = 80 * 1024;

/** JPEG 质量：0.82 是「看不出压缩痕迹」与「省一半体积」的常用折中 */
export const PHOTO_QUALITY = 0.82;

export const PHOTO_UNSUPPORTED = '当前浏览器不支持图片压缩，暂时传不了照片';
export const PHOTO_NOT_IMAGE = '这个文件不是图片，换一张照片试试';
export const PHOTO_TOO_BIG = `照片压缩后仍超过 ${Math.round(PHOTO_MAX_BYTES / 1024)} KB，请换一张更小的图`;

/**
 * data URL 的**解码后**字节数。
 *
 * 为什么要算解码后的：localStorage 存的是 base64 字符串，配额按 UTF-16 字符算，
 * 而用户理解的「80 KB」是图片体积。用解码后字节数跟 80 KB 比，
 * 才不会出现「提示 80 KB 上限，实际占了 110 KB」这种说不清的账。
 */
export function byteSizeOf(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** 等比缩到宽 ≤ max 的尺寸（已经够小就原样返回，不放大） */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: max, height: max };
  }
  if (width <= max) return { width: Math.round(width), height: Math.round(height) };
  const ratio = max / width;
  return { width: max, height: Math.max(1, Math.round(height * ratio)) };
}

/** 把 File 读成 data URL（`FileReader` 在浏览器与 jsdom 里都有） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(PHOTO_UNSUPPORTED));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

/** 把位图画进 canvas 并导出 JPEG */
function drawToJpeg(source: ImageBitmap | HTMLImageElement, width: number, height: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // 白底：PNG 透明区域转 JPEG 会变黑块（证件照一般没有透明区，但截图有）
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
}

/**
 * 读文件 → 等比缩到 ≤480px → 导 JPEG → 校验体积。
 *
 * 返回 `data:` URL（`check-no-network` 只拦 http(s)，data: 合规、可离线打印）。
 * 任何一步失败都给出可读原因，绝不返回半成品。
 */
export async function compressPhoto(file: File): Promise<PhotoHandle> {
  if (file.type && !file.type.startsWith('image/')) return { ok: false, reason: PHOTO_NOT_IMAGE };
  // 没有 DOM 就没有 canvas（node / 服务端渲染 / 测试环境）。
  // 这里必须**说出来**，而不是抛一个 ReferenceError 让调用方猜。
  if (typeof document === 'undefined') return { ok: false, reason: PHOTO_UNSUPPORTED };

  let source: ImageBitmap | HTMLImageElement;
  try {
    if (typeof createImageBitmap === 'function') {
      source = await createImageBitmap(file);
    } else {
      // 老 Safari 没有 createImageBitmap：退回 <img> + data URL
      const dataUrl = await readAsDataUrl(file);
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(PHOTO_NOT_IMAGE));
        image.src = dataUrl;
      });
    }
  } catch {
    return { ok: false, reason: PHOTO_NOT_IMAGE };
  }

  const box = fitWithin(source.width, source.height, PHOTO_MAX_WIDTH);
  const dataUrl = drawToJpeg(source, box.width, box.height);
  if (!dataUrl) return { ok: false, reason: PHOTO_UNSUPPORTED };

  const bytes = byteSizeOf(dataUrl);
  if (bytes > PHOTO_MAX_BYTES) return { ok: false, reason: PHOTO_TOO_BIG };
  return { ok: true, dataUrl, bytes };
}
