import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { conversations } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { listConversations, summaryDTO } from '@/lib/conversations';
import { HttpError, handleError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/conversations — 分页列表（q 标题搜索）
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const page = await listConversations(user.id, {
      q: url.searchParams.get('q'),
      limit: Number(url.searchParams.get('limit')) || undefined,
      offset: Number(url.searchParams.get('offset')) || undefined,
    });
    return NextResponse.json(page);
  } catch (error) {
    return handleError(error);
  }
}

const createSchema = z.object({ title: z.string().max(200).optional() });

// POST /api/conversations — 新建会话
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const parsed = createSchema.safeParse(await readJson(request).catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, '参数不合法');
    const title = (parsed.data.title ?? '新的对话').trim() || '新的对话';
    const [conversation] = await db.insert(conversations).values({ userId: user.id, title }).returning();
    return NextResponse.json(summaryDTO(conversation));
  } catch (error) {
    return handleError(error);
  }
}
