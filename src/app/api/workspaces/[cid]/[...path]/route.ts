import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/db';
import { conversations } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { conversationWorkspaceDir } from '@/lib/agent/paths';
import { HttpError, handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ cid: string; path: string[] }> };

// GET /api/workspaces/[cid]/[...path] — 下载会话工作目录内的工具产出文件。
// 归属校验（404 不泄露存在性）+ resolve 后 containment（防 .. 越界读到其他会话/宿主文件）。
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { cid, path: segments } = await params;
    const relative = segments.join('/');
    if (!relative.trim()) throw new HttpError(404, '文件不存在');

    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, cid), eq(conversations.userId, user.id)))
      .limit(1);
    if (!owned) throw new HttpError(404, '文件不存在');

    const workspace = path.resolve(conversationWorkspaceDir(cid));
    const target = path.resolve(workspace, relative);
    if (target !== workspace && !target.startsWith(workspace + path.sep)) {
      throw new HttpError(404, '文件不存在');
    }
    if (!statSync(target).isFile()) throw new HttpError(404, '文件不存在');

    const nodeStream = Readable.toWeb(createReadStream(target)) as WebReadableStream<Uint8Array>;
    return new NextResponse(nodeStream as unknown as ReadableStream, {
      headers: {
        'Content-Length': String(statSync(target).size),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(target))}"`,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
