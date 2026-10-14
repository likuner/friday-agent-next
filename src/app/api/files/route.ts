import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth/guard';
import { FILES_DIR } from '@/lib/agent/paths';
import { MAX_IMAGE_BYTES, sniffImage } from '@/lib/files';
import { HttpError, handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/files — 上传一张图片，返回落盘文件名、访问 URL 与大小
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw new HttpError(400, '缺少文件字段 file');

    const raw = new Uint8Array(await file.arrayBuffer());
    if (!raw.length) throw new HttpError(400, '文件为空');
    if (raw.length > MAX_IMAGE_BYTES) throw new HttpError(413, '图片不能超过 5 MB');

    const ext = sniffImage(raw);
    if (!ext) throw new HttpError(400, '只支持图片文件');

    const name = `${randomUUID().replaceAll('-', '')}.${ext}`;
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(`${FILES_DIR}/${name}`, raw);
    console.info(`[files] 图片上传 user=${user.username} name=${name} size=${raw.length}`);
    return NextResponse.json({ name, url: `/api/files/${name}`, size: raw.length }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
