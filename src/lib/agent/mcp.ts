import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from 'ai';

import { env } from '@/lib/env';

// MCP 工具挂载（对应原 backend/app/agent_mcps.py）：medical_rag_search / web_search
// 的实现在 mcp-server 侧，这里只负责连接、白名单注册与不可达静默降级。

export type McpToolSet = { tools: Record<string, Tool>; close: () => Promise<void> };

const EMPTY: McpToolSet = { tools: {}, close: async () => {} };

/**
 * 连接 mcp-server 并取白名单内的工具。每轮请求临时建 HTTP 会话（对应原
 * is_stateful=False），服务端不可达时静默降级为空工具集，对话继续不报错。
 */
export async function loadMcpTools(enableTools: string[]): Promise<McpToolSet> {
  if (!env.mcpServerUrl) return EMPTY;
  let client: MCPClient | null = null;
  try {
    client = await createMCPClient({
      transport: new StreamableHTTPClientTransport(new URL(env.mcpServerUrl), {
        requestInit: env.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${env.mcpAuthToken}` } }
          : undefined,
      }),
    });
    const all = await client.tools();
    const tools: Record<string, Tool> = {};
    for (const name of enableTools) {
      if (all[name]) tools[name] = all[name];
    }
    console.info(`[mcp] 工具注册 server=${env.mcpServerUrl} tools=${Object.keys(tools).join(',') || '(无匹配)'}`);
    const held = client;
    return { tools, close: () => held.close() };
  } catch (error) {
    // 这条日志是排查「mcp-server 未启动导致检索工具悄悄消失」的主线索
    console.warn(`[mcp] 工具注册失败 server=${env.mcpServerUrl}：${error}（本轮对话无检索工具，继续）`);
    if (client) await client.close().catch(() => {});
    return EMPTY;
  }
}
