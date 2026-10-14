// 上下文装配：按 token 预算把库中消息切分为「回放窗口 + 待压缩溢出段」。
// 对应原 backend/app/context.py（纯计算，不做 IO）。
//
// 每轮模型上下文的组成（自上而下）：
//   ① system prompt（人设 + 可选模块）
//   ② 滚动摘要（注入 system prompt 尾部，phase 5 生效）
//   ③ 回放窗口（预算内最近若干轮，纯文本 user/assistant 消息）
//   ④ 本轮用户消息 + 图片附件（图片只随本轮发，历史附件替换为占位）

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;

/** 字符近似估算 token 数（中文 ≈1.6 字/token，其余 ≈4 字/token；预算是软约束）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK) || []).length;
  const other = text.length - cjk;
  return Math.floor(cjk / 1.6 + other / 4) + 1;
}

export type ReplayableMessage = {
  id: string;
  role: string;
  content: string | null;
  meta?: Record<string, unknown> | null;
};

/** 清洗单条消息为可回放的纯文本；不可回放（空内容）返回 null。tool_call/thinking 只存在于 meta，天然不进入回放；历史图片附件不重发给模型，替换为「[图片]」占位。 */
export function cleanForReplay(message: ReplayableMessage): { role: 'user' | 'assistant'; content: string } | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  let content = String(message.content ?? '').trim();
  if ((message.meta as { attachments?: unknown[] } | null)?.attachments?.length) {
    content = `[图片] ${content}`.trim();
  }
  if (!content) return null; // 中止生成的空回复、纯空白内容：既不回放也不进摘要
  return { role: message.role as 'user' | 'assistant', content };
}

export type ContextWindow = {
  /** 回放窗口（旧→新） */
  replay: { role: 'user' | 'assistant'; content: string }[];
  replayTokens: number;
  /** 溢出段原始消息（旧→新），供摘要管线取 id 与全文 */
  overflow: ReplayableMessage[];
  overflowTokens: number;
};

/** 把消息序列切成回放窗口与溢出段：从最新向前塞满预算即停，单条超剩余预算整条不塞（不切半条）。 */
export function buildContextWindow(
  messages: ReplayableMessage[],
  summaryUptoId: string | null | undefined,
  budgetTokens: number,
): ContextWindow {
  let eligible = messages;
  if (summaryUptoId) {
    const index = eligible.findIndex((message) => message.id === summaryUptoId);
    if (index >= 0) eligible = eligible.slice(index + 1);
  }

  const window: ContextWindow = { replay: [], replayTokens: 0, overflow: [], overflowTokens: 0 };
  let oldestIndex: number | null = null;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const cleaned = cleanForReplay(eligible[index]);
    if (!cleaned) continue;
    const cost = estimateTokens(cleaned.content);
    if (window.replayTokens + cost > budgetTokens) break;
    window.replay.unshift(cleaned);
    window.replayTokens += cost;
    oldestIndex = index;
  }

  const boundary = oldestIndex ?? eligible.length; // 窗口为空时可回放的全部归入溢出段
  window.overflow = eligible.slice(0, boundary).filter((message) => cleanForReplay(message) !== null);
  window.overflowTokens = window.overflow.reduce((sum, message) => sum + estimateTokens(cleanForReplay(message)!.content), 0);
  return window;
}

/** 摘要游标之后的新消息条数（长期记忆抽取阈值用；游标不在序列中则全量计数）。 */
export function messagesSinceExtract(messages: ReplayableMessage[], extractedUptoId: string | null | undefined): number {
  if (!extractedUptoId) return messages.length;
  const index = messages.findIndex((message) => message.id === extractedUptoId);
  const eligible = index >= 0 ? messages.slice(index + 1) : messages;
  return eligible.filter((message) => cleanForReplay(message) !== null).length;
}
