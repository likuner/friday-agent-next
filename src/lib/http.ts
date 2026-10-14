import { NextResponse } from 'next/server';

// 带状态码的业务错误：路由里 throw，统一由 withRoute 捕获转成 {detail} 响应
// （与原 FastAPI 的 HTTPException/detail 协议一致，前端 api.ts 靠 detail 取消息）
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function apiError(status: number, detail: string) {
  return NextResponse.json({ detail }, { status });
}

// 路由统一错误出口：HttpError 按其状态码返回，其余按 500 且不泄露内部细节
export function handleError(error: unknown) {
  if (error instanceof HttpError) return apiError(error.status, error.message);
  console.error('[api] unhandled error:', error);
  return apiError(500, '服务器内部错误');
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}
