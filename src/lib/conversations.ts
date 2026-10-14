import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import { conversations, messages } from '@/db/schema';
import type { Conversation, Message } from '@/db/schema';

// 会话列表/详情的响应装配（对应原 conversations.py 的 summary() 与 schemas）

export type ConversationSummaryDTO = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string | null;
};

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : '');

export function messageDTO(item: Message) {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    meta: item.meta ?? {},
    created_at: iso(item.createdAt),
  };
}

/** 组装单条会话摘要；消息计数与末条预览由列表查询单独批量取。 */
export function summaryDTO(
  conversation: Conversation,
  messageCount = 0,
  lastMessage: string | null = null,
): ConversationSummaryDTO {
  return {
    id: conversation.id,
    title: conversation.title,
    created_at: iso(conversation.createdAt),
    updated_at: iso(conversation.updatedAt),
    message_count: messageCount,
    last_message: lastMessage,
  };
}

/** 批量取一组会话的消息计数与末条消息预览（每会话一条走索引的小查询，页大小 ≤ 100）。 */
export async function messageStats(conversationIds: string[]) {
  const counts = new Map<string, number>();
  const lasts = new Map<string, string>();
  if (conversationIds.length === 0) return { counts, lasts };

  const countRows = await db
    .select({ cid: messages.conversationId, n: sql<number>`count(*)::int` })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds))
    .groupBy(messages.conversationId);
  for (const row of countRows) counts.set(row.cid, row.n);

  await Promise.all(
    conversationIds.map(async (cid) => {
      const [last] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, cid))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      if (last) lasts.set(cid, last.content.slice(0, 100));
    }),
  );
  return { counts, lasts };
}

/** 搜索词 → ILIKE 模式：转义 LIKE 通配符（Postgres 默认转义符即反斜杠），用户输入的 % / _ 按字面量匹配。 */
function likePattern(keyword: string): string {
  const escaped = keyword.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `%${escaped}%`;
}

export type ListQuery = { q?: string | null; limit?: number; offset?: number };

/** 会话分页列表：标题关键词（ILIKE）过滤，按最近更新倒序。 */
export async function listConversations(userId: string, query: ListQuery) {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);

  const conditions = [eq(conversations.userId, userId)];
  if (query.q?.trim()) conditions.push(ilike(conversations.title, likePattern(query.q)));
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(conversations)
    .where(where);

  const rows = await db
    .select()
    .from(conversations)
    .where(where)
    // updated_at 可能重复（同一秒建的会话）：补 id 兜底，保证 offset 分页不跳条不重条
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit)
    .offset(offset);

  const { counts, lasts } = await messageStats(rows.map((row) => row.id));
  const items = rows.map((row) =>
    summaryDTO(row, counts.get(row.id) ?? 0, lasts.get(row.id) ?? null),
  );
  return { items, total, has_more: offset + items.length < total };
}

/** 取本人会话，不存在/非本人返回 null。 */
export async function getOwnedConversation(userId: string, conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** 会话详情：摘要 + 全部消息（旧→新）。 */
export async function conversationDetail(userId: string, conversationId: string) {
  const conversation = await getOwnedConversation(userId, conversationId);
  if (!conversation) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt, messages.id);
  const base = summaryDTO(conversation, rows.length, rows.length ? rows[rows.length - 1].content.slice(0, 100) : null);
  return { ...base, messages: rows.map(messageDTO) };
}
