import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import { conversations } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { conversationDetail, getOwnedConversation, messageStats, summaryDTO } from '@/lib/conversations';
import { HttpError, handleError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// GET /api/conversations/[id] — 详情（含全部消息）
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const detail = await conversationDetail(user.id, id);
    if (!detail) throw new HttpError(404, '对话不存在');
    return NextResponse.json(detail);
  } catch (error) {
    return handleError(error);
  }
}

const patchSchema = z.object({ title: z.string().max(200) });

// PATCH /api/conversations/[id] — 重命名
export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, '参数不合法');
    const row = await getOwnedConversation(user.id, id);
    if (!row) throw new HttpError(404, '对话不存在');
    const title = parsed.data.title.trim() || row.title;
    const [updated] = await db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .returning();
    const { counts, lasts } = await messageStats([id]);
    return NextResponse.json(summaryDTO(updated, counts.get(id) ?? 0, lasts.get(id) ?? null));
  } catch (error) {
    return handleError(error);
  }
}

// DELETE /api/conversations/[id] — 删除（级联消息）
export async function DELETE(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const deleted = await db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .returning({ id: conversations.id });
    if (deleted.length === 0) throw new HttpError(404, '对话不存在');
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleError(error);
  }
}
