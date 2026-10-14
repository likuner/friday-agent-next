import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FILES_DIR } from '@/lib/agent/paths';

// 图片上传存储（对应原 backend/app/files.py）：仅接受真实图片内容（不信客户端后缀与 Content-Type）。

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// 魔数嗅探 → 落盘后缀（等价 Pillow 的格式识别，覆盖五类）
const MAGIC: Array<{ ext: string; bytes: number[] }> = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46] }, // GIF87a / GIF89a
  { ext: 'bmp', bytes: [0x42, 0x4d] },
];
const EXT_MEDIA: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/** 只接受本服务生成的文件名（32 位十六进制 + 白名单后缀），杜绝路径穿越 */
export function isSafeName(name: string): boolean {
  return /^[0-9a-f]{32}\.(?:png|jpg|webp|gif|bmp)$/.test(name || '');
}

/** 嗅探图片字节：返回落盘后缀；非图片（或 WEBP 以外的 RIFF）返回 null。 */
export function sniffImage(raw: Uint8Array): string | null {
  for (const { ext, bytes } of MAGIC) {
    if (bytes.every((byte, index) => raw[index] === byte)) return ext;
  }
  // WEBP：RIFF....WEBP
  if (raw.length >= 12) {
    const riff = String.fromCharCode(...raw.slice(0, 4));
    const webp = String.fromCharCode(...raw.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'webp';
  }
  return null;
}

export function mediaTypeOf(ext: string): string {
  return EXT_MEDIA[ext];
}

/** 把客户端传来的附件名解析成本地路径 + MIME；非法、越界或不存在返回 null。 */
export function resolveStoredImage(name: string): { path: string; mediaType: string } | null {
  if (!isSafeName(name)) return null;
  // 白名单之外再作显式边界校验：resolve 后必须仍位于 FILES_DIR 内
  const root = path.resolve(FILES_DIR);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (!existsSync(target) || !readFileSync(target).length) return null;
  const ext = name.split('.').pop()!;
  return { path: target, mediaType: EXT_MEDIA[ext] };
}
