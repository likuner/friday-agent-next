import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { env } from '@/lib/env';

// 项目根：next dev / next start 的进程工作目录即项目根。
// 不能用 __dirname——Turbopack 服务端打包会把它改写成运行时的占位路径。
export const PROJECT_ROOT = process.cwd();

// 工作目录根：与 files/（上传图片）同级，每个会话一个固定子目录（Agent 工具的唯一落脚点）
export const WORKSPACES_DIR = path.join(PROJECT_ROOT, env.workspacesDir);

// 上传图片存储目录（对应原 backend/files）
export const FILES_DIR = path.join(PROJECT_ROOT, 'files');

/** 本会话专属的工作目录（固定路径，调用方按需 mkdir）。 */
export function conversationWorkspaceDir(conversationId: string): string {
  return path.join(WORKSPACES_DIR, conversationId);
}

export function expandHome(input: string): string {
  if (input === '~') return process.env.HOME || input;
  if (input.startsWith('~/')) return path.join(process.env.HOME || '', input.slice(2));
  return input;
}

/** 确保目录存在。 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
