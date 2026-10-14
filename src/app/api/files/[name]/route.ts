import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';

import { NextResponse } from 'next/server';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';

import { requireUser } from '@/lib/auth/guard';
import { resolveStoredImage } from '@/lib/files';
import { HttpError, handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ name: string }> };

// GET /api/files/[name] — 获取已上传的图片（文件名走白名单解析，防路径穿越）
export async function GET(request: Request, { params }: Params) {
  try {
    await requireUser(request);
    const { name } = await params;
    const resolved = resolveStoredImage(name);
    if (!resolved) throw new HttpError(404, '图片不存在');

    const nodeStream = Readable.toWeb(createReadStream(resolved.path)) as WebReadableStream<Uint8Array>;
    return new NextResponse(nodeStream as unknown as ReadableStream, {
      headers: {
        'Content-Type': resolved.mediaType,
        'Content-Length': String(statSync(resolved.path).size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
