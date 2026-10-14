import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';

import { db } from '@/db';
import { conversations, messages } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { HttpError, handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; messageId: string }> };

// DELETE /api/conversations/[id]/messages/[messageId] — 删除指定消息及其后全部（编辑重发截断）
export async function DELETE(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { id, messageId } = await params;

    const [target] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(messages.id, messageId), eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);
    if (!target) throw new HttpError(404, '消息不存在');

    // 同轮消息的提交时间均有微秒级间隔，>= 目标时间不会误删更早的消息
    const deleted = await db
      .delete(messages)
      .where(and(eq(messages.conversationId, id), gte(messages.createdAt, target.createdAt)))
      .returning({ id: messages.id });

    return NextResponse.json({ deleted: deleted.length });
  } catch (error) {
    return handleError(error);
  }
}
