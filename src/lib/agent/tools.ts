import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { tool } from 'ai';
import { z } from 'zod';

import { expandHome } from '@/lib/agent/paths';

// Agent 内置工具的 TS 实现（对应原 AgentScope 内置工具组）。
// 工具调用不再有权限裁决：会话工作目录固定，调用直接执行，
// 工具本体只负责执行与安全收尾（输出截断、超时、路径解析）。

const execAsync = promisify(exec);

// 输出截断：超长输出只留头尾，避免撑爆模型上下文
const MAX_OUTPUT = 15_000;
function clampOutput(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, Math.floor(MAX_OUTPUT * 0.7));
  const tail = text.slice(-Math.floor(MAX_OUTPUT * 0.25));
  return `${head}\n\n……（输出过长，中间省略 ${text.length - head.length - tail.length} 字符）……\n\n${tail}`;
}

/** 把模型给的路径解析为绝对路径（相对路径相对工作区；~ 展开）。 */
export function resolveToolPath(input: string, workspace: string): string {
  const expanded = expandHome(input.trim());
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(workspace, expanded);
}

// 会话级任务清单（对应 AgentScope 任务四件套的进程内状态；本机单副本部署与原实现一致）
export type AgentTask = {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'done';
  created_at: string;
  updated_at: string;
};
const globalForTasks = globalThis as unknown as { fridayTasks?: Map<string, AgentTask[]> };
const taskStores = globalForTasks.fridayTasks ?? new Map<string, AgentTask[]>();
if (!globalForTasks.fridayTasks) globalForTasks.fridayTasks = taskStores;

const tasks = (conversationId: string) => {
  if (!taskStores.has(conversationId)) taskStores.set(conversationId, []);
  return taskStores.get(conversationId)!;
};

/** 组装全部内置工具（工作区路径随会话解析后传入）。 */
export function buildBuiltinTools(workspace: string, conversationId: string) {
  return {
    Bash: tool({
      description: '在工作目录中执行 shell 命令并返回输出（stdout + stderr）。适合运行代码、安装依赖、批处理文件。',
      inputSchema: z.object({
        command: z.string().describe('要执行的命令（相对路径相对工作目录）'),
        timeout: z.number().int().positive().max(600_000).optional().describe('超时毫秒数，默认 120000'),
      }),
      execute: async ({ command, timeout }) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workspace,
            timeout: timeout ?? 120_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          return { ok: true, output: clampOutput(output) || '（无输出）' };
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || err.message || '执行失败';
          return { ok: false, output: clampOutput(err.killed ? `命令超时被终止。${output}` : output) };
        }
      },
    }),

    Read: tool({
      description: '读取文本文件内容。可指定起始行号与行数。',
      inputSchema: z.object({
        file_path: z.string().describe('文件绝对路径'),
        offset: z.number().int().positive().optional().describe('起始行号（从 1 开始）'),
        limit: z.number().int().positive().max(2000).optional().describe('读取行数，默认 500'),
      }),
      execute: async ({ file_path, offset, limit }) => {
        const target = resolveToolPath(file_path, workspace);
        if (!existsSync(target) || !statSync(target).isFile()) return { ok: false, error: `文件不存在：${target}` };
        const lines = readFileSync(target, 'utf8').split('\n');
        const start = (offset ?? 1) - 1;
        const slice = lines.slice(start, start + (limit ?? 500));
        const numbered = slice.map((line, index) => `${start + index + 1} | ${line}`).join('\n');
        return { ok: true, content: clampOutput(numbered) };
      },
    }),

    Write: tool({
      description: '把内容写入文件（整体覆盖）。目录不存在时自动创建。建议写在本会话工作目录内。',
      inputSchema: z.object({
        file_path: z.string().describe('目标文件绝对路径'),
        content: z.string().describe('写入的完整内容'),
      }),
      execute: async ({ file_path, content }) => {
        const target = resolveToolPath(file_path, workspace);
        try {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content, 'utf8');
          return { ok: true, written: content.length, file: target };
        } catch (error) {
          return { ok: false, error: `写入失败：${(error as Error).message}` };
        }
      },
    }),

    Edit: tool({
      description: '替换文件中的一段文本（old_string 精确匹配第一个出现处；不存在时报错）。',
      inputSchema: z.object({
        file_path: z.string().describe('目标文件绝对路径'),
        old_string: z.string().describe('要替换的原文（必须与文件内容完全一致）'),
        new_string: z.string().describe('替换后的文本'),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const target = resolveToolPath(file_path, workspace);
        if (!existsSync(target)) return { ok: false, error: `文件不存在：${target}` };
        const current = readFileSync(target, 'utf8');
        const index = current.indexOf(old_string);
        if (index < 0) return { ok: false, error: 'old_string 在文件中未找到' };
        writeFileSync(target, current.slice(0, index) + new_string + current.slice(index + old_string.length), 'utf8');
        return { ok: true, file: target };
      },
    }),

    Glob: tool({
      description: '按通配模式查找文件（如 "**/*.py"），返回相对工作目录的路径列表。',
      inputSchema: z.object({
        pattern: z.string().describe('glob 模式'),
        path: z.string().optional().describe('查找根目录（默认工作目录）'),
      }),
      execute: async ({ pattern, path: rootInput }) => {
        const root = rootInput ? resolveToolPath(rootInput, workspace) : workspace;
        const { glob } = await import('glob');
        const matches = await glob(pattern, { cwd: root, nodir: true, dot: true });
        if (!matches.length) return { ok: true, files: [], note: '没有匹配的文件' };
        return { ok: true, files: matches.slice(0, 200) };
      },
    }),

    Grep: tool({
      description: '在文件内容中按正则搜索，返回 文件:行号:内容 列表。',
      inputSchema: z.object({
        pattern: z.string().describe('正则表达式'),
        path: z.string().optional().describe('搜索根目录（默认工作目录）'),
        include: z.string().optional().describe('文件名过滤 glob，如 "*.py"'),
      }),
      execute: async ({ pattern, path: rootInput, include }) => {
        const root = rootInput ? resolveToolPath(rootInput, workspace) : workspace;
        const { glob } = await import('glob');
        const files = await glob(include || '**/*', { cwd: root, nodir: true, dot: true });
        const regex = new RegExp(pattern);
        const hits: string[] = [];
        outer: for (const file of files.slice(0, 2000)) {
          let content: string;
          try {
            content = readFileSync(path.resolve(root, file), 'utf8');
          } catch {
            continue; // 二进制或权限问题跳过
          }
          for (const [index, line] of content.split('\n').entries()) {
            if (regex.test(line)) {
              hits.push(`${file}:${index + 1}:${line.trim().slice(0, 200)}`);
              if (hits.length >= 100) break outer;
            }
          }
        }
        return { ok: true, matches: hits };
      },
    }),

    TaskCreate: tool({
      description: '创建一个任务（多步骤工作的进度跟踪）。',
      inputSchema: z.object({
        subject: z.string().describe('任务标题'),
        description: z.string().optional().describe('任务说明'),
      }),
      execute: async ({ subject, description }) => {
        const list = tasks(conversationId);
        const now = new Date().toISOString();
        const taskItem: AgentTask = {
          id: String(list.length + 1),
          subject,
          description,
          status: 'pending',
          created_at: now,
          updated_at: now,
        };
        list.push(taskItem);
        return { ok: true, task: taskItem };
      },
    }),

    TaskGet: tool({
      description: '按 id 查看任务详情。',
      inputSchema: z.object({ task_id: z.string() }),
      execute: async ({ task_id }) => {
        const found = tasks(conversationId).find((item) => item.id === task_id);
        return found ? { ok: true, task: found } : { ok: false, error: '任务不存在' };
      },
    }),

    TaskList: tool({
      description: '列出全部任务。',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, tasks: tasks(conversationId) }),
    }),

    TaskUpdate: tool({
      description: '更新任务状态或内容。',
      inputSchema: z.object({
        task_id: z.string(),
        status: z.enum(['pending', 'in_progress', 'done']).optional(),
        subject: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async ({ task_id, status, subject, description }) => {
        const found = tasks(conversationId).find((item) => item.id === task_id);
        if (!found) return { ok: false, error: '任务不存在' };
        if (status) found.status = status;
        if (subject) found.subject = subject;
        if (description) found.description = description;
        found.updated_at = new Date().toISOString();
        return { ok: true, task: found };
      },
    }),
  };
}
