import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { stepCountIs, streamText, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai';
import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { conversations, messages } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { getOwnedConversation } from '@/lib/conversations';
import { env } from '@/lib/env';
import { handleError } from '@/lib/http';
import { chatModel } from '@/lib/models';
import { loadMcpTools } from '@/lib/agent/mcp';
import { conversationWorkspaceDir, ensureDir } from '@/lib/agent/paths';
import { AGENT_TOOLS_PROMPT, SYSTEM_PROMPT, WEB_SEARCH_PROMPT } from '@/lib/agent/prompts';
import { buildBuiltinTools } from '@/lib/agent/tools';
import { buildContextWindow } from '@/lib/chat/context';
import { resolveStoredImage } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  content: z.string().max(20000).default(''),
  deep_thinking: z.boolean().default(false),
  web_search: z.boolean().default(false),
  attachments: z.array(z.string()).max(9).default([]),
});

// chip 摘要的参数键优先级：检索词 → 命令 → 文件路径 → 搜索模式 → 目录 → 任务标题 → 技能名
const TOOL_QUERY_KEYS = ['query', 'command', 'file_path', 'pattern', 'path', 'subject', 'skill'] as const;

function toolQuery(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of TOOL_QUERY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 40);
  }
  return '';
}

async function demoAnswer(prompt: string): Promise<string> {
  return (
    '收到，我先把这个问题拆成可执行的步骤。\n\n' +
    `你当前的问题是：${prompt}\n\n` +
    '建议先明确目标、输入和验收标准，再按最小闭环实现。' +
    '如果这是工程问题，可以从数据结构、错误处理、性能边界和测试用例四个方面逐项确认。\n\n' +
    '当前服务未配置外部模型密钥，因此这里返回的是本地演示流式回复。' +
    '配置 OPENAI_API_KEY 并将 MODEL_PROVIDER 设置为 deepseek 后，会通过 Vercel AI SDK 调用 DeepSeek。'
  );
}

// POST /api/conversations/[id]/messages —— 核心流式端点（UIMessage data stream）
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ detail: '参数不合法' }, { status: 400 });
    const payload = parsed.data;

    const row = await getOwnedConversation(user.id, id);
    if (!row) return NextResponse.json({ detail: '对话不存在' }, { status: 404 });

    const historyRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const history = historyRows.map((item) => ({ ...item, meta: (item.meta ?? {}) as Record<string, unknown> }));

    if (!payload.content.trim() && payload.attachments.length === 0) {
      return NextResponse.json({ detail: '消息内容不能为空' }, { status: 422 });
    }

    const [userMessage] = await db
      .insert(messages)
      .values({ conversationId: id, role: 'user', content: payload.content, meta: { attachments: payload.attachments } })
      .returning();
    if (row.title === '新的对话') {
      await db
        .update(conversations)
        .set({ title: payload.content.trim().slice(0, 30) || '图片对话' })
        .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)));
    }

    // 长期记忆块（阶段 5 接入；结构先留空）
    const memoryBlock: string | null = null;

    const window = buildContextWindow(history, row.summaryUptoMessageId, env.contextTokenBudget);
    console.info(
      `[chat] conversation=${id} replay=${window.replay.length}条(≈${window.replayTokens}tok) overflow=${window.overflow.length}条(≈${window.overflowTokens}tok) 摘要=${Boolean(row.summary)} thinking=${payload.deep_thinking} search=${payload.web_search}`,
    );
    // 溢出摘要 / 长期记忆抽取：阶段 5 作为后台任务挂入

    // 本轮用户消息：图片附件读成 base64 file parts 只随本轮发（历史图片回放为「[图片]」占位）
    const imageParts: { type: 'file'; data: string; mediaType: string }[] = [];
    for (const name of payload.attachments) {
      const resolved = resolveStoredImage(name);
      if (!resolved) {
        console.warn(`[chat] 附件跳过：不存在或名称非法 name=${name}`);
        continue;
      }
      const data = await readFile(resolved.path);
      imageParts.push({ type: 'file', data: data.toString('base64'), mediaType: resolved.mediaType });
    }

    const replayMessages: ModelMessage[] = window.replay.map((item) => ({ role: item.role, content: item.content }) as ModelMessage);
    const currentUserMessage: ModelMessage = imageParts.length
      ? { role: 'user', content: [{ type: 'text', text: payload.content || '请描述这张图片。' }, ...imageParts] }
      : { role: 'user', content: payload.content };

    return await runStream({
      request,
      conversationId: id,
      userMessage,
      window: replayMessages,
      currentUserMessage,
      deepThinking: payload.deep_thinking,
      webSearch: payload.web_search,
      summary: row.summary,
      memoryBlock,
    });
  } catch (error) {
    // 只覆盖建流前的失败（鉴权/校验/落库）；流内错误已由 writer 的 error 部件承接
    return handleError(error);
  }
}

// ===== 流式执行核心 =====
type RunStreamArgs = {
  request: Request;
  conversationId: string;
  userMessage: typeof messages.$inferSelect;
  window: ModelMessage[];
  currentUserMessage: ModelMessage;
  deepThinking: boolean;
  webSearch: boolean;
  summary: string | null;
  memoryBlock: string | null;
};

async function runStream(args: RunStreamArgs) {
  const { request, conversationId, userMessage, summary, memoryBlock } = args;
  const deepThinking = args.deepThinking;
  const webSearch = args.webSearch;

  // ---- MCP 工具：medical_rag_search 常挂，web_search 按开关；不可达静默降级 ----
  const mcp = env.mcpServerUrl
    ? await loadMcpTools(['medical_rag_search', ...(webSearch ? ['web_search'] : [])])
    : { tools: {}, close: async () => {} };
  const useSearch = webSearch && 'web_search' in mcp.tools;

  // ---- Agent 内置工具：固定会话工作目录，调用直接放行 ----
  const allTools: ToolSet = { ...mcp.tools };
  let agentPrompt = '';
  if (env.agentToolsEnabled) {
    const workspace = conversationWorkspaceDir(conversationId);
    ensureDir(workspace);
    Object.assign(allTools, buildBuiltinTools(workspace, conversationId));
    agentPrompt = AGENT_TOOLS_PROMPT
      .replaceAll('{workspace}', workspace)
      .replaceAll('{public_prefix}', `/api/workspaces/${conversationId}`);
  }

  // ---- system prompt ----
  let system = SYSTEM_PROMPT;
  if (memoryBlock) system += `\n\n${memoryBlock}`;
  if (useSearch) system += `\n\n${WEB_SEARCH_PROMPT}`;
  if (agentPrompt) system += `\n\n${agentPrompt}`;
  if (summary) system += `\n\n【本会话此前对话的滚动摘要（要点记录，细节以最近消息为准）】\n${summary}`;

  const model = chatModel(deepThinking);

  // ---- 消息序列 ----
  // 无思考模型 / 无检索工具时的提示词降级（与原实现降级策略一致）；仅纯文本消息可加前缀
  if (typeof args.currentUserMessage.content === 'string') {
    if (deepThinking && (!model || !env.openaiThinkingModel)) {
      args.currentUserMessage.content = `请深度思考后回答。\n\n${args.currentUserMessage.content}`;
    }
    if (webSearch && !useSearch) {
      args.currentUserMessage.content = `请结合联网检索能力回答；如果无法访问网络，请明确说明。\n\n${args.currentUserMessage.content}`;
    }
  }
  const modelMessages: ModelMessage[] = [...args.window, args.currentUserMessage];
  const userContent = typeof args.currentUserMessage.content === 'string' ? args.currentUserMessage.content : '';

  // 预生成 assistant 消息 id：流首 data-saved 回传
  const assistantId = randomUUID();

  // ---- 流式持久化状态 ----
  let answerText = '';
  let thinkingText = '';
  const toolCalls: { name: string; query?: string }[] = [];
  let persisted = false;

  const persist = async (stopped: boolean) => {
    if (persisted) return;
    persisted = true;
    const content = answerText;
    const meta = {
      deep_thinking: deepThinking,
      web_search: webSearch,
      toolCalls,
      thinking: thinkingText,
      ...(stopped ? { stopped: true } : {}),
    };
    try {
      await db.insert(messages).values({ id: assistantId, conversationId, role: 'assistant', content, meta });
      console.info(`[chat] 保存回复 conversation=${conversationId} message=${assistantId} chars=${content.length} stopped=${stopped}`);
    } catch (error) {
      console.error(`[chat] 保存回复失败 conversation=${conversationId}:`, error);
    }
  };

  // 客户端「停止生成」：abort 触发时把已生成的部分落库（标记 stopped）
  request.signal.addEventListener('abort', () => void persist(true), { once: true });

  const { createUIMessageStream, createUIMessageStreamResponse } = await import('ai');

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // 流首数据：回传真实 user 消息 id（前端乐观渲染替换）+ 预生成的 assistant id
      writer.write({
        type: 'data-saved',
        id: 'saved',
        data: { user_message_id: userMessage.id, assistant_message_id: assistantId },
      } satisfies UIMessageChunk);

      if (!model) {
        // ---- 演示模式：本地假流 ----
        console.info(`[chat] 演示模式 conversation=${conversationId} prompt=${userContent.slice(0, 100)}`);
        if (deepThinking) {
          thinkingText = '正在梳理问题的上下文、约束条件和可执行步骤。';
          const reasoningId = randomUUID();
          writer.write({ type: 'reasoning-start', id: reasoningId });
          writer.write({ type: 'reasoning-delta', id: reasoningId, delta: thinkingText });
          writer.write({ type: 'reasoning-end', id: reasoningId });
        }
        const textId = randomUUID();
        writer.write({ type: 'text-start', id: textId });
        const answer = await demoAnswer(userContent);
        for (let index = 0; index < answer.length; index += 4) {
          const delta = answer.slice(index, index + 4);
          answerText += delta;
          writer.write({ type: 'text-delta', id: textId, delta });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        writer.write({ type: 'text-end', id: textId });
        await persist(false);
        await mcp.close();
        return;
      }

      // ---- 真实模型：streamText + 手动翻译 fullStream → UIMessage 流 ----
      const result = streamText({
        model,
        system,
        messages: modelMessages,
        tools: Object.keys(allTools).length ? allTools : undefined,
        abortSignal: request.signal,
        stopWhen: stepCountIs(50),
      });

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-start':
              writer.write({ type: 'text-start', id: part.id });
              break;
            case 'text-delta':
              answerText += part.text;
              writer.write({ type: 'text-delta', id: part.id, delta: part.text });
              break;
            case 'text-end':
              writer.write({ type: 'text-end', id: part.id });
              break;
            case 'reasoning-start':
              writer.write({ type: 'reasoning-start', id: part.id });
              break;
            case 'reasoning-delta':
              thinkingText += part.text;
              writer.write({ type: 'reasoning-delta', id: part.id, delta: part.text });
              break;
            case 'reasoning-end':
              writer.write({ type: 'reasoning-end', id: part.id });
              break;
            case 'tool-call': {
              // 工具入参收全：建立工具部件 + 下发 chip（检索词/命令等）
              const chip = { name: part.toolName, query: toolQuery(part.input) };
              toolCalls.push(chip);
              writer.write({ type: 'tool-input-available', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
              writer.write({ type: 'data-tool-chip', id: part.toolCallId, data: chip } satisfies UIMessageChunk);
              break;
            }
            case 'tool-result':
              writer.write({ type: 'tool-output-available', toolCallId: part.toolCallId, output: part.output });
              break;
            case 'error':
              console.error(`[chat] 流式错误 conversation=${conversationId}:`, part.error);
              writer.write({ type: 'error', errorText: '生成回复时出现错误，请稍后重试' });
              break;
            default:
              break;
          }
        }
        await persist(false);
      } catch (error) {
        if (request.signal.aborted) {
          await persist(true); // abort 已由监听器处理，这里兜底幂等
        } else {
          console.error(`[chat] 流式异常 conversation=${conversationId}:`, error);
          writer.write({ type: 'error', errorText: '生成回复时出现错误，请稍后重试' });
          await persist(false);
        }
      } finally {
        // 每轮临时 HTTP 会话用完即收（对应原 is_stateful=False）
        await mcp.close();
      }
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}
