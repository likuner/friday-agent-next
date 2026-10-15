// 环境变量集中读取（对应原 backend/app/config.py）。
// Next.js 会自动加载项目根 .env，这里只做类型转换、默认值与弱密钥拒绝。
function str(key: string, fallback = ''): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function int(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

// 已知弱密钥：命中即拒绝，防止漏配后静默用可预测值签发 token
const WEAK_JWT_SECRETS = new Set(['', 'change-me', 'replace-with-a-long-random-secret']);
const jwtSecret = str('JWT_SECRET', 'change-me');
if (WEAK_JWT_SECRETS.has(jwtSecret.trim().toLowerCase())) {
  throw new Error('JWT_SECRET 未配置或为弱默认值：请在 .env 中设置随机长密钥（可用 `openssl rand -hex 32` 生成）后重启');
}

export const env = {
  appEnv: str('APP_ENV', 'development'),
  databaseUrl: str('DATABASE_URL', 'postgresql://friday:friday@localhost:5433/friday_agent'),
  jwtSecret,
  jwtExpireMinutes: int('JWT_EXPIRE_MINUTES', 10080),

  modelProvider: str('MODEL_PROVIDER', 'demo'),
  openaiApiKey: str('OPENAI_API_KEY'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.deepseek.com'),
  openaiModel: str('OPENAI_MODEL', 'deepseek-flash'),
  openaiThinkingModel: str('OPENAI_THINKING_MODEL', 'deepseek-flash'),

  zhipuApiKey: str('ZHIPU_API_KEY'),
  glmBaseUrl: str('GLM_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
  glmModel: str('GLM_MODEL', 'glm-5.3-flash'),

  mcpServerUrl: str('MCP_SERVER_URL', 'http://127.0.0.1:8806/mcp'),
  mcpAuthToken: str('MCP_AUTH_TOKEN'),

  contextTokenBudget: int('CONTEXT_TOKEN_BUDGET', 1000),
  summaryMaxTokens: int('SUMMARY_MAX_TOKENS', 500),
  summaryMinOverflowTokens: int('SUMMARY_MIN_OVERFLOW_TOKENS', 200),

  memoryEnabled: bool('MEMORY_ENABLED', true),
  memoryExtractMinMessages: int('MEMORY_EXTRACT_MIN_MESSAGES', 1),
  memoryMaxTokens: int('MEMORY_MAX_TOKENS', 500),

  agentToolsEnabled: bool('AGENT_TOOLS_ENABLED', true),
  workspacesDir: str('WORKSPACES_DIR', 'workspaces'),
} as const;

export type Env = typeof env;
