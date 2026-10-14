import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { env } from '@/lib/env';

// 模型接入工厂：DeepSeek（主对话，OpenAI 兼容）与 GLM（摘要/记忆辅助模型）。
// MODEL_PROVIDER=demo 时返回 null，调用方降级为本地假流。

const deepSeekProvider = createOpenAICompatible({
  name: 'deepseek',
  baseURL: env.openaiBaseUrl,
  apiKey: env.openaiApiKey,
});

const glmProvider = createOpenAICompatible({
  name: 'zhipu-glm',
  baseURL: env.glmBaseUrl,
  apiKey: env.zhipuApiKey,
});

/** 主对话模型是否可用（demo 模式返回 null）。 */
export function chatModel(deepThinking: boolean) {
  if (env.modelProvider !== 'deepseek' || !env.openaiApiKey) return null;
  return deepSeekProvider.chatModel(deepThinking ? env.openaiThinkingModel : env.openaiModel);
}

/** GLM 辅助模型（滚动摘要 / 长期记忆）；未配置智谱密钥返回 null。 */
export function glmModel() {
  if (!env.zhipuApiKey) return null;
  return glmProvider.chatModel(env.glmModel);
}
