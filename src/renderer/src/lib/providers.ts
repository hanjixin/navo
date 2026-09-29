import type { Provider, ProviderType } from '@shared/types'

export interface Preset {
  id: string
  name: string
  type: ProviderType
  baseURL: string
  keyUrl?: string
  /** Fallback suggestions when the model list can't be fetched */
  models: string[]
}

/** Common providers. Model ids are only suggestions; the list is fetched from the provider when possible. */
export const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseURL: '',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  },
  { id: 'openai', name: 'OpenAI', type: 'openai-responses', baseURL: '', keyUrl: 'https://platform.openai.com/api-keys', models: ['gpt-5.1', 'gpt-5-mini'] },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    name: '通义千问',
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    type: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    type: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    type: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    models: [],
  },
  { id: 'ollama', name: 'Ollama（本地）', type: 'openai-compatible', baseURL: 'http://localhost:11434/v1', models: [] },
]

export const presetFor = (p: Provider) =>
  PRESETS.find((x) => (x.baseURL && p.baseURL && new URL(x.baseURL).host === new URL(p.baseURL).host) || (!x.baseURL && !p.baseURL && x.type === p.type))

const VISION =
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt|\bo[134](-|$)|claude|gemini|gemma-3|llama-4|llama-3\.2.*vision|pixtral|mistral-(medium|small)-3|[-_.]?vl\b|-vl-|qvq|omni|glm-4(\.\d)?v|internvl|llava|minicpm-v|vision|step-1[ov]|doubao-(seed|1\.5-vision)/i
const TEXT_ONLY =
  /deepseek|kimi-k2|moonshot-v1-(8|32|128)k$|minimax-m|qwen3?-(max|plus|turbo|coder)|qwq|glm-4(\.\d)?(-air|-flash)?$|ernie|embedding|whisper|tts/i

/** Best guess whether a model accepts image input; the user can still flip the switch. */
export function guessVision(type: Provider['type'], model: string): boolean {
  if (!model) return type !== 'openai-compatible'
  if (VISION.test(model)) return true
  if (TEXT_ONLY.test(model)) return false
  return type !== 'openai-compatible'
}
