'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownOutlined, CloseOutlined, CodeOutlined, CopyOutlined, DownOutlined, EditOutlined, FileTextOutlined, FolderOpenOutlined, GlobalOutlined, LikeFilled, LikeOutlined, OrderedListOutlined, PaperClipOutlined, PictureOutlined, SendOutlined, BulbOutlined, LoadingOutlined, MenuOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import { App, Button, Image as AntdImage } from 'antd';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { authImageUrl, conversation, createConversation, truncateMessages, uploadImage, type ToolCall, type UploadedFile } from '@/lib/api';
import Markdown from '@/components/Markdown';
import ThemeToggle from '@/components/ThemeToggle';
import Logo from '@/components/Logo';
import { useAuth } from '@/store/auth';
import { useUI } from '@/store/ui';

// 「深度思考」「联网搜索」开关控制：
// 深度思考：开启后改用支持 reasoning 的模型，流式展示思考过程，回答结束后可折叠
const SHOW_DEEP_THINKING = true;
// 联网搜索：开启后后端注册 web_search 工具，模型 tool_call 转交 GLM 联网检索执行
const SHOW_WEB_SEARCH = true;
// Agent 内置工具由后端 AGENT_TOOLS_ENABLED 统一开关，前端不再有入口。

// 内置工具名（区别于检索类工具，运行提示显示「正在执行」）
const BUILTIN_TOOL_NAMES = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']);

// 距底部小于该像素即视为「贴着底部」，此时流式内容会自动跟随
const STICK_THRESHOLD = 48;

// 单条消息最多可带几张图片（与后端 ChatRequest.attachments 的上限保持一致）
const MAX_ATTACHMENTS = 9;

// UIMessage 约定：metadata 承载服务端 id / 附件 / 历史回放所需 meta；
// data-* 部件由流式端点下发（data-saved / data-tool-chip）
type FridayMetadata = {
  serverId?: string;
  attachments?: string[];
  stopped?: boolean;
  // 历史消息回放用（DB meta 平移）
  toolCalls?: ToolCall[];
  thinking?: string;
};
type FridayData = {
  'tool-chip': { name: string; query?: string };
  saved: { user_message_id: string; assistant_message_id: string };
};
type FridayUIMessage = UIMessage<FridayMetadata, FridayData>;

const textOf = (message: FridayUIMessage): string =>
  message.parts.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('');

const reasoningOf = (message: FridayUIMessage): string =>
  message.parts.filter((part): part is Extract<typeof part, { type: 'reasoning' }> => part.type === 'reasoning').map((part) => part.text).join('');

// DB 消息 → UIMessage（历史回放：thinking/toolCalls/stopped 进 metadata）
function toUIMessage(item: { id: string; role: 'user' | 'assistant'; content: string; meta: Record<string, unknown> }): FridayUIMessage {
  const metadata: FridayMetadata = {
    serverId: item.id,
    attachments: (item.meta?.attachments as string[]) || undefined,
    stopped: Boolean(item.meta?.stopped),
    toolCalls: (item.meta?.toolCalls as ToolCall[]) || undefined,
    thinking: (item.meta?.thinking as string) || undefined,
  };
  return {
    id: item.id,
    role: item.role,
    metadata,
    parts: item.content ? [{ type: 'text', text: item.content }] : [],
  };
}

// 消息里的图片附件
// 单张图片：文件缺失/被删时降级成占位块，避免浏览器显示裂图
function MessageImage({ name }: { name: string }) {
  const token = useAuth((state) => state.token);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setSrc(undefined);
    if (!token) return;
    authImageUrl(token, name).then(
      (url) => { if (alive) setSrc(url); },
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, [token, name]);
  if (failed || (!src && !token)) {
    return (
      <div className="flex h-[120px] w-[160px] flex-col items-center justify-center gap-1 rounded-xl border border-line bg-soft text-[11px] text-muted">
        <PictureOutlined />
        <span>图片已失效</span>
      </div>
    );
  }
  if (!src) {
    return (
      <div className="flex h-[120px] w-[160px] items-center justify-center rounded-xl border border-line bg-soft text-muted">
        <LoadingOutlined />
      </div>
    );
  }
  // antd Image 自带预览（点击放大 / 缩放 / 旋转 / 下载），且跟随主题
  return (
    <AntdImage
      src={src}
      alt="图片附件"
      onError={() => setFailed(true)}
      width={160}
      height={120}
      style={{ objectFit: 'cover' }}
      className="rounded-xl"
      wrapperClassName="overflow-hidden rounded-xl"
    />
  );
}

function MessageImages({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {names.map((name) => <MessageImage key={name} name={name} />)}
    </div>
  );
}

// 待发送附件的缩略图：与消息内图片一样走鉴权取图（复用同一缓存）
function AttachmentThumb({ name }: { name: string }) {
  const token = useAuth((state) => state.token);
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let alive = true;
    if (!token) return;
    authImageUrl(token, name).then((url) => { if (alive) setSrc(url); }, () => {});
    return () => { alive = false; };
  }, [token, name]);
  return <img src={src} alt="待发送图片" className="h-16 w-16 rounded-lg border border-line bg-soft object-cover" />;
}

// 用户消息：图片单独展示在气泡之外，只有文字进蓝色气泡；气泡下方提供复制与编辑重发
function UserMessage({ content, attachments, serverId, busy, onCopy, onResend }: { content: string; attachments: string[]; serverId?: string; busy: boolean; onCopy: (text: string) => void; onResend: (serverId: string | undefined, content: string, attachments: string[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  if (!attachments.length && !content) return null;

  const cancel = () => { setEditing(false); setDraft(content); };
  const submit = () => {
    if (!draft.trim()) return;
    setEditing(false);
    onResend(serverId, draft, attachments);
  };

  return (
    <div className="flex max-w-[85%] flex-col items-end gap-2">
      <MessageImages names={attachments} />
      {editing ? (
        <div className="w-full rounded-2xl border border-line-focus bg-surface p-3 shadow-[0_12px_28px_-18px_rgba(77,107,254,.6)]">
          <div className="mb-1 text-xs font-medium text-[#dbe4ff]">你</div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancel();
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
            }}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            autoFocus
            className="block w-full resize-none border-0 bg-transparent py-1 text-[14.5px] leading-6 outline-none"
          />
          <div className="mt-1 flex items-center justify-end gap-1 text-xs">
            <button type="button" onClick={cancel} className="rounded px-2 py-1 text-muted transition-colors hover:bg-hover">取消</button>
            <button type="button" onClick={submit} disabled={!draft.trim()} title="保存后会删除这条之后的消息并重新发送" className="rounded px-2 py-1 font-medium text-brand transition-colors hover:bg-hover disabled:opacity-50">保存并重发</button>
          </div>
        </div>
      ) : (
        <>
          {content && (
            <div className="rounded-2xl rounded-tr-md bg-gradient-to-br from-[#4d6bfe] to-[#7288ff] px-4 py-3 text-white shadow-[0_12px_28px_-14px_rgba(77,107,254,.75)]">
              <div className="mb-1 text-xs font-medium text-[#dbe4ff]">你</div>
              <div className="whitespace-pre-wrap text-[14.5px] leading-7">{content}</div>
            </div>
          )}
          {/* 纯多模态（如仅图片、无文字）的消息没有可编辑的文本，不提供复制/编辑重发 */}
          {content && (
            <div className="flex items-center gap-1 text-xs text-muted-weak">
              <button onClick={() => onCopy(content)} className="rounded px-2 py-1 transition-colors hover:bg-hover">
                <CopyOutlined /> 复制
              </button>
              <button
                onClick={() => { setDraft(content); setEditing(true); }}
                disabled={busy}
                title={busy ? '生成中暂不能编辑' : '编辑这条提问并重新发送（该条之后的消息会被删除）'}
                className="rounded px-2 py-1 transition-colors hover:bg-hover disabled:opacity-50"
              >
                <EditOutlined /> 编辑重发
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 思考过程面板：流式期间展开，回答结束后自动收起，可手动展开/折叠
function ThinkingPanel({ text, streaming, open, onToggle }: { text: string; streaming: boolean; open: boolean; onToggle: () => void }) {
  if (!text) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-soft">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted transition-colors hover:bg-hover">
        <BulbOutlined />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
        <span className="ml-auto text-[11px]">{open ? '收起' : '展开'}</span>
        {open ? <UpOutlined className="text-[10px]" /> : <DownOutlined className="text-[10px]" />}
      </button>
      {open && <div className="scroll-hide max-h-[320px] overflow-y-auto whitespace-pre-wrap border-t border-line px-3 py-2 text-[13px] leading-6 text-body">{text}</div>}
    </div>
  );
}

// 流式期间的状态提示：无正文时的占位（正在思考/正在检索），或调用工具期间显示在已有正文下方
function StreamingHint({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[14.5px] text-muted">
      <LoadingOutlined spin className="text-[#4d6bfe]" /> {label}
      <span className="thinking-dot">…</span>
    </div>
  );
}

// 工具 chip 的展示映射：按工具名选图标与文案（query 字段承载检索词/命令/文件路径/任务标题）
function toolChipInfo(call: ToolCall): { icon: ReactNode; label: string } {
  const q = call.query || '';
  switch (call.name) {
    case 'web_search': return { icon: <GlobalOutlined />, label: `联网搜索：${q || '网络'}` };
    case 'Bash': return { icon: <CodeOutlined />, label: `已执行命令：${q || 'shell'}` };
    case 'Read': return { icon: <FileTextOutlined />, label: `已读取：${q || '文件'}` };
    case 'Write': return { icon: <FileTextOutlined />, label: `已写入：${q || '文件'}` };
    case 'Edit': return { icon: <EditOutlined />, label: `已编辑：${q || '文件'}` };
    case 'Glob': return { icon: <FolderOpenOutlined />, label: `已查找文件：${q || '工作区'}` };
    case 'Grep': return { icon: <SearchOutlined />, label: `已搜索内容：${q || '工作区'}` };
    case 'TaskCreate':
    case 'TaskUpdate': return { icon: <OrderedListOutlined />, label: `任务规划：${q || '更新进度'}` };
    case 'TaskGet':
    case 'TaskList': return { icon: <OrderedListOutlined />, label: '查看任务清单' };
    // medical_rag_search 及未知工具按本地文献检索展示
    default: return { icon: <SearchOutlined />, label: `已检索：${q || '医学文献库'}` };
  }
}

// 展示本轮的检索记录：一次回答可能并行检索多个角度，逐个显示实际检索词，避免看起来像重复 chip
function ToolCallChips({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {calls.map((call, index) => {
        const { icon, label } = toolChipInfo(call);
        return (
          <span key={index} title={call.query || call.name} className="inline-flex max-w-[320px] items-center gap-1 rounded-full border border-line-brand bg-brand-soft px-2.5 py-1 text-[11px] text-brand-text">
            {icon}
            <span className="truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function ChatWorkspace({ conversationId }: { conversationId?: string }) {
  const { message } = App.useApp();
  const token = useAuth((state) => state.token);
  const setSidebarOpen = useUI((state) => state.setSidebarOpen);
  const bumpConversations = useUI((state) => state.bumpConversations);
  const [id, setId] = useState(conversationId);
  // 会话切换的实参（懒创建后变化），transport 经 ref 读取保证发送时是最新的
  const idRef = useRef(conversationId);
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  const [title, setTitle] = useState('新的对话');
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [searching, setSearching] = useState(false);
  const thinkingRef = useRef(false);
  const searchingRef = useRef(false);
  useEffect(() => { thinkingRef.current = thinking; }, [thinking]);
  useEffect(() => { searchingRef.current = searching; }, [searching]);
  // 待发送附件名（发送时经 transport body 提交，展示用 UploadedFile）
  const attachmentsRef = useRef<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // 用户手动展开/收起思考过程的覆盖值
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  // 待发送的图片附件（已上传到后端 files）
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // 「有帮助」点赞状态（仅前端会话内，暂不落库）
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  // 是否跟随底部：用户主动上滑阅读时置 false，滚回底部附近自动恢复
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const jumpToBottom = () => {
    stick.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  };

  // 用户上滑后不再被流式输出拉回底部；回到底部附近则恢复自动跟随
  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const following = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stick.current = following;
    setAtBottom(following);
  };

  const chat = useChat<FridayUIMessage>({
    transport: new DefaultChatTransport({
      // 请求体完全自定义：端点是传统 REST 形态（content + 开关位），不是 UIMessage 数组
      prepareSendMessagesRequest: ({ messages: outgoing }) => {
        const lastUser = [...outgoing].reverse().find((item) => item.role === 'user');
        return {
          api: `/api/conversations/${idRef.current}/messages`,
          headers: {
            'Content-Type': 'application/json',
            ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
          },
          // body 传对象，由 transport 负责 JSON 序列化
          body: {
            content: lastUser ? textOf(lastUser as FridayUIMessage) : '',
            deep_thinking: thinkingRef.current,
            web_search: searchingRef.current,
            attachments: attachmentsRef.current,
          },
        };
      },
    }),
    onData: (part) => {
      // data-saved：流首回传真实 user 消息 id——给最后一条「尚未换取服务端 id」的用户消息
      // 记下 serverId，编辑重发的截断才能按 id 定位
      if (part.type === 'data-saved' && part.data?.user_message_id) {
        const serverId = part.data.user_message_id;
        setMessages((old) => {
          const index = findLastIndex(old, (item) => item.role === 'user' && !item.metadata?.serverId);
          if (index < 0) return old;
          return old.map((item, position) =>
            position === index ? { ...item, metadata: { ...item.metadata, serverId } } : item,
          );
        });
      }
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '发送失败');
    },
  });
  const { messages, setMessages, sendMessage, status, stop } = chat;
  const busy = status === 'submitted' || status === 'streaming';
  const streamingMessageId = busy ? messages[messages.length - 1]?.id : null;
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // 会话切换：重置滚动并载入详情
  useEffect(() => {
    stick.current = true; setAtBottom(true);
    if (token && conversationId) {
      conversation(token, conversationId).then((data) => {
        idRef.current = data.id;
        setId(data.id); setTitle(data.title);
        setMessages(data.messages.map(toUIMessage));
      });
    } else {
      setId(undefined); setTitle('新的对话'); setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, conversationId]);

  // 只有用户本来贴着底部才自动跟随：流式输出期间上滑阅读不会被拉回底部
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages]);

  const stopGenerating = () => {
    // 中止 fetch：服务端 abort 保存部分内容；本地标记 stopped（刷新后由 DB meta.stopped 承载）
    const list = messagesRef.current;
    const lastAssistant = findLastIndex(list, (item) => item.role === 'assistant');
    if (lastAssistant >= 0) {
      setMessages((old) => old.map((item, index) =>
        index === lastAssistant ? { ...item, metadata: { ...item.metadata, stopped: true } } : item,
      ));
    }
    stop();
    message.info('已停止生成');
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('复制成功');
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  };

  const toggleLike = (id: string) => {
    const next = !liked[id];
    setLiked((old) => ({ ...old, [id]: next }));
    message.success(next ? '已点赞，感谢反馈' : '已取消点赞');
  };

  const pickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = ''; // 清空以便连续选择同一批文件
    if (!picked.length || !token) return;

    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      message.warning(`最多只能添加 ${MAX_ATTACHMENTS} 张图片`);
      return;
    }
    const accepted = picked.slice(0, room);
    if (picked.length > room) message.warning(`最多 ${MAX_ATTACHMENTS} 张，已只添加前 ${room} 张`);

    const images = accepted.filter((file) => file.type.startsWith('image/'));
    if (images.length < accepted.length) message.warning('已跳过非图片文件');
    if (!images.length) return;

    // 多张并发上传，单张失败不影响其它
    setUploading(true);
    const results = await Promise.allSettled(images.map((file) => uploadImage(token, file)));
    const uploaded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.length - uploaded.length;
    if (uploaded.length) setAttachments((old) => [...old, ...uploaded]);
    if (uploaded.length > 1) message.success(`${uploaded.length} 张图片上传成功`);
    else if (uploaded.length === 1) message.success('图片上传成功');
    if (failed) message.error(`${failed} 张图片上传失败`);
    setUploading(false);
  };

  // override：编辑重发时直接给定内容与附件名，不读取（也不清空）输入框里的草稿
  const send = async (override?: { content: string; attachments: string[] }) => {
    const content = (override?.content ?? input).trim();
    const sentAttachments = override ? override.attachments : attachments.map((item) => item.name);
    if ((!content && !sentAttachments.length) || busy || !token) return;
    if (!idRef.current) {
      // 懒创建：首条消息发出时建会话并改写地址栏（不触发重挂载）
      const created = await createConversation(token, content.slice(0, 30));
      idRef.current = created.id;
      setId(created.id); setTitle(created.title);
      window.history.replaceState(null, '', `/chat/${created.id}`);
      bumpConversations();
    }
    if (!override) { setInput(''); setAttachments([]); }
    attachmentsRef.current = sentAttachments;
    stick.current = true; setAtBottom(true);
    await sendMessage({ text: content, metadata: { attachments: sentAttachments } });
  };

  // 编辑重发：把该条及其后的消息截断（前端 + 后端），再以编辑后的内容走正常发送链路
  const resendFrom = async (serverId: string | undefined, content: string, sentAttachments: string[]) => {
    if (busy || !token || !idRef.current) return;
    if (!serverId) {
      message.error('这条消息还没有落库 id，请稍后重试');
      return;
    }
    try {
      await truncateMessages(token, idRef.current, serverId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '截断历史消息失败，请稍后重试');
      return;
    }
    const index = findLastIndex(messagesRef.current, (item) => item.metadata?.serverId === serverId || item.id === serverId);
    if (index >= 0) setMessages((old) => old.slice(0, index));
    await send({ content, attachments: sentAttachments });
  };

  const renderedMessages = useMemo(() => messages, [messages]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-line/80 bg-surface/75 px-4 backdrop-blur-md sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            title="打开菜单"
            onClick={() => setSidebarOpen(true)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-body hover:bg-hover md:hidden"
          >
            <MenuOutlined />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-medium">{title}</h1>
            <span className="text-xs text-muted-weak">{renderedMessages.length} 条消息</span>
          </div>
        </div>
        <ThemeToggle />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} onScroll={handleScroll} className="scroll-hide min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[800px] space-y-7 px-4 py-7 sm:px-6">
            {renderedMessages.length === 0 ? (
              <div className="pt-14 text-center">
                <Logo className="mx-auto h-14 w-14 drop-shadow-[0_10px_24px_rgba(77,107,254,.35)]" />
                <h2 className="mt-5 text-2xl font-semibold">Hi，我是 Friday</h2>
                <p className="mx-auto mt-2 max-w-[460px] text-[13.5px] leading-6 text-muted">
                  我可以帮你写代码、读文件、写作、做方案，也能联网查最新资料。
                </p>
              </div>
            ) : (
              renderedMessages.map((item) => {
                if (item.role === 'user') {
                  return (
                    <div key={item.id} className="msg-in flex justify-end">
                      <UserMessage
                        content={textOf(item)}
                        attachments={item.metadata?.attachments || []}
                        serverId={item.metadata?.serverId}
                        busy={busy}
                        onCopy={copyText}
                        onResend={resendFrom}
                      />
                    </div>
                  );
                }
                // 思考文本：流式来自 reasoning parts，历史回放来自 metadata.thinking
                const thinkingText = reasoningOf(item) || item.metadata?.thinking || '';
                const isStreamingThis = item.id === streamingMessageId;
                const thinkingExpanded = thinkingOpen[item.id] ?? isStreamingThis;
                // chips：流式来自 data-tool-chip parts，历史回放来自 metadata.toolCalls
                const chips: ToolCall[] = isStreamingThis
                  ? item.parts
                      .filter((part) => part.type.startsWith('data-tool-chip'))
                      .map((part) => (part as unknown as { data: ToolCall }).data)
                      .filter(Boolean)
                  : (item.metadata?.toolCalls || []);
                // 工具运行中提示：最后一个 part 是工具 chip 且尚无其后的正文增量
                const lastPart = item.parts[item.parts.length - 1];
                const toolRunning = isStreamingThis && Boolean(lastPart && lastPart.type.startsWith('data-tool-chip'));
                const runningTool = toolRunning ? (lastPart as unknown as { data?: { name?: string } }).data?.name || '' : '';
                const content = textOf(item);
                return (
                  <div key={item.id} className="msg-in flex gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                        <Logo className="h-5 w-5" />
                        Friday Agent
                      </div>
                      <ToolCallChips calls={chips} />
                      {thinkingText && (
                        <ThinkingPanel
                          text={thinkingText}
                          streaming={isStreamingThis}
                          open={thinkingExpanded}
                          onToggle={() => setThinkingOpen((old) => ({ ...old, [item.id]: !thinkingExpanded }))}
                        />
                      )}
                      {content ? (
                        <div className="md">
                          <Markdown streaming={isStreamingThis}>{content}</Markdown>
                          {isStreamingThis && toolRunning && (
                            <div className="mt-1">
                              <StreamingHint label={BUILTIN_TOOL_NAMES.has(runningTool) ? '正在执行' : '正在检索'} />
                            </div>
                          )}
                          <div className="mt-2 flex gap-1 text-xs text-muted-weak">
                            <button onClick={() => copyText(content)} className="rounded px-2 py-1 transition-colors hover:bg-hover">
                              <CopyOutlined /> 复制
                            </button>
                            <button
                              onClick={() => toggleLike(item.id)}
                              className={`rounded px-2 py-1 transition-colors hover:bg-hover ${liked[item.id] ? 'text-brand' : ''}`}
                            >
                              {liked[item.id] ? <LikeFilled /> : <LikeOutlined />} 有帮助
                            </button>
                          </div>
                        </div>
                      ) : (
                        <StreamingHint label={isStreamingThis && toolRunning ? (BUILTIN_TOOL_NAMES.has(runningTool) ? '正在执行' : '正在检索') : '正在思考'} />
                      )}
                      {item.metadata?.stopped ? <div className="mt-2 text-xs text-muted-weak">已停止生成</div> : null}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottom} />
          </div>
        </div>
        {!atBottom && (
          <button
            onClick={jumpToBottom}
            title="回到底部"
            aria-label="回到底部"
            className="absolute bottom-4 left-1/2 z-10 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-surface text-muted shadow-[0_10px_24px_-12px_rgba(20,35,80,.6)] transition-colors hover:bg-hover hover:text-ink"
          >
            <ArrowDownOutlined />
          </button>
        )}
      </div>
      <div className="shrink-0 px-4 pb-5 pt-1 sm:px-6">
        <div className="mx-auto max-w-[800px] rounded-[24px] border border-line-strong bg-surface/95 px-4 pb-2.5 pt-3 shadow-[0_18px_44px_-24px_rgba(20,35,80,.35)] backdrop-blur transition-all duration-200 focus-within:border-line-focus focus-within:shadow-[0_18px_46px_-20px_rgba(77,107,254,.5)]">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((item) => (
                <div key={item.name} className="relative">
                  <AttachmentThumb name={item.name} />
                  <button
                    type="button"
                    title="移除图片"
                    onClick={() => setAttachments((old) => old.filter((row) => row.name !== item.name))}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-[10px] text-muted hover:text-ink"
                  >
                    <CloseOutlined />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="给 Friday 发送消息…"
            className="block w-full resize-none border-0 bg-transparent py-1 text-[14.5px] leading-6 outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              title={`上传图片（最多 ${MAX_ATTACHMENTS} 张）`}
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="grid h-8 w-8 place-items-center rounded-lg text-weak hover:bg-hover disabled:opacity-50"
            >
              {uploading ? <LoadingOutlined spin /> : <PaperClipOutlined />}
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={pickImage} />
            {SHOW_DEEP_THINKING && (
              <button
                onClick={() => setThinking(!thinking)}
                className={`rounded-full border px-3 py-1 text-xs ${thinking ? 'border-[#4d6bfe] bg-brand-soft text-brand-text' : 'border-line-strong text-weak'}`}
              >
                <BulbOutlined /> 深度思考
              </button>
            )}
            {SHOW_WEB_SEARCH && (
              <button
                onClick={() => setSearching(!searching)}
                className={`rounded-full border px-3 py-1 text-xs ${searching ? 'border-[#4d6bfe] bg-brand-soft text-brand-text' : 'border-line-strong text-weak'}`}
              >
                <GlobalOutlined /> 联网搜索
              </button>
            )}
            {busy ? (
              <button
                type="button"
                onClick={stopGenerating}
                title="停止生成"
                aria-label="停止生成"
                className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line-brand bg-brand-soft text-brand-text shadow-[0_6px_16px_-10px_rgba(77,107,254,.9)] transition-colors hover:border-line-hover hover:bg-hover hover:text-ink"
              >
                <span className="block h-3 w-3 rounded-[3px] bg-current" />
              </button>
            ) : (
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined />}
                disabled={!input.trim() && !attachments.length}
                onClick={() => void send()}
                className="ml-auto h-9 w-9 border-0 bg-gradient-to-br from-[#4d6bfe] to-[#7288ff] shadow-[0_8px_18px_-8px_rgba(77,107,254,.9)] transition-transform hover:scale-105"
              />
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[11.5px] text-muted-weak">内容由 AI 生成，请仔细甄别</p>
      </div>
    </div>
  );
}

// Array.prototype.findLastIndex 的简易实现（目标 ES 版本对齐）
function findLastIndex<T>(list: T[], predicate: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index;
  }
  return -1;
}
