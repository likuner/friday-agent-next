// 同源全栈：所有请求走本 Next.js 应用的 /api 路由（原版此处指向独立 FastAPI 后端）
const API_URL = '/api';

// 带 HTTP 状态码的业务错误：调用方靠它区分 401（登录失效）与网络中断/5xx。
// fetch 本身被中断（AbortError/Failed to fetch）不是 ApiError，天然不会误判为登录失效
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type User = { id: string; username: string };
export type Conversation = { id: string; title: string; created_at: string; updated_at: string; message_count: number; last_message?: string | null };
export type Message = { id: string; role: 'user' | 'assistant'; content: string; meta: Record<string, unknown>; created_at: string };
// 一条工具调用记录（meta.toolCalls 的元素）；query 是本次实际检索词
export type ToolCall = { name: string; query?: string };
// 上传后的图片附件（后端返回的 name 即文件名）
export type UploadedFile = { name: string; url: string; size: number };
export type ConversationDetail = Conversation & { messages: Message[] };

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.detail || '请求失败');
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export async function captcha() { return api<{ image: string; token: string }>('/auth/captcha'); }
export async function login(payload: object) { return api<{ access_token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(payload) }); }
export async function register(payload: object) { return api<{ access_token: string; user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(payload) }); }
// 会话分页列表：服务端按标题关键词（q）过滤后分页，每页默认 20 条
export type ConversationPage = { items: Conversation[]; total: number; has_more: boolean };
export type ConversationQuery = { q?: string; limit?: number; offset?: number };
export async function conversations(token: string, query: ConversationQuery = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.offset != null) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return api<ConversationPage>(`/conversations${suffix ? `?${suffix}` : ''}`, {}, token);
}
export async function conversation(token: string, id: string) { return api<ConversationDetail>(`/conversations/${id}`, {}, token); }
export async function createConversation(token: string, title = '新的对话') { return api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ title }) }, token); }
export async function renameConversation(token: string, id: string, title: string) { return api<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }, token); }
export async function deleteConversation(token: string, id: string) { return api<void>(`/conversations/${id}`, { method: 'DELETE' }, token); }
// 编辑重发用：删除指定消息及其后的全部消息，返回删除条数
export async function truncateMessages(token: string, conversationId: string, messageId: string) { return api<{ deleted: number }>(`/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }, token); }

// 把模型回复里给出的相对路径（/api/workspaces/...）解析成可请求地址；
// 同源部署下相对路径原样返回即可
export function resolveBackendUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

// 图片附件走鉴权路由 GET /api/files/{name}：<img> 标签带不上 Authorization，
// 改为带 token 取 blob 后生成对象 URL。模块级缓存：同一张图在消息列表与
// 预览里只拉一次；对象 URL 随页面生命周期存在，不做 revoke（受会话内图片数约束）
const imageUrlCache = new Map<string, Promise<string>>();

export function authImageUrl(token: string, name: string): Promise<string> {
  const cached = imageUrlCache.get(name);
  if (cached) return cached;
  const task = fetch(`${API_URL}/files/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`图片加载失败（${response.status}）`);
    return URL.createObjectURL(await response.blob());
  });
  imageUrlCache.set(name, task);
  // 失败不进缓存，下次渲染还有重试机会
  task.catch(() => imageUrlCache.delete(name));
  return task;
}

// markdown 正文里引用的工作区产出（/api/workspaces/...）同样带不上 Authorization：
// 取 blob 生成对象 URL 给 <img> 用，按完整路径缓存，策略与 authImageUrl 一致
const assetUrlCache = new Map<string, Promise<string>>();

export function authAssetUrl(token: string, path: string): Promise<string> {
  const cached = assetUrlCache.get(path);
  if (cached) return cached;
  const task = fetch(resolveBackendUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`资源加载失败（${response.status}）`);
    return URL.createObjectURL(await response.blob());
  });
  assetUrlCache.set(path, task);
  task.catch(() => assetUrlCache.delete(path));
  return task;
}

// 下载会话工作目录内的工具产出文件（鉴权路由，路径形如 /api/workspaces/<cid>/<file>）：
// 浏览器直链导航带不上 token，由前端拦截链接后取 blob 触发下载
export async function downloadWorkspaceFile(token: string, path: string) {
  const response = await fetch(resolveBackendUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('文件下载失败');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = decodeURIComponent(path.split('/').pop() || 'download');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function uploadImage(token: string, file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API_URL}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || '上传失败');
  }
  return response.json();
}
