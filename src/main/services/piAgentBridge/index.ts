// pi-agent SDK 桥接层：官方 SDK 设计 —— 用 ModelRuntime.registerProvider 把
// llama-studio 的本地模型端点（OpenAI 兼容）注册为自定义 provider，然后
// createAgentSession({ model, modelRuntime }) 让 pi 内置的 openai-completions
// provider 直连本地端点。不写自定义 provider：推理（thinking_* 事件）、重试、
// 采样参数、max_tokens 兜底等全部由 pi 原生产生。
//
// 注意：pi 系包均为 ESM-only（exports 仅 import 条件），main 构建输出是 CJS，
// 静态 import 会在运行时 require 失败（ERR_PACKAGE_PATH_NOT_EXPORTED），
// 因此运行时依赖全部走动态 import（import() 匹配 import 条件）。
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent'

type PiModule = typeof import('@earendil-works/pi-coding-agent')

let piModulePromise: Promise<PiModule> | null = null
function getPi(): Promise<PiModule> {
  if (!piModulePromise) piModulePromise = import('@earendil-works/pi-coding-agent')
  return piModulePromise
}

/** llama-studio 本地模型在 pi ModelRuntime 中的 provider / model id */
export const LLAMA_STUDIO_PROVIDER_ID = 'llama-studio'
export const LLAMA_STUDIO_MODEL_ID = 'local-model'

export interface PiAgentBridgeOptions {
  /** 返回当前会话绑定的本地模型端口（llama-server 监听端口）；undefined = 无可用模型 */
  getPort: () => number | undefined
  /** 会话级采样参数（temperature/top_p 等，作为 model.samplingParams） */
  getExtraBody?: () => Record<string, unknown>
  /** 模型上下文窗口 token 数（供 pi 的 auto-compaction 阈值计算） */
  getContextWindow?: () => number
  /** agent 工作目录 */
  cwd: string
  /** pi 配置目录（放 auth.json/models.json；llama-studio 传自己的目录避免污染用户 ~/.pi） */
  agentDir?: string
  /** 要启用的工具名列表（仅列自定义工具，不启用 pi 内置 read/bash/edit/write） */
  toolNames: string[]
  /** 追加到 system prompt 的工具使用指导（如计划工具说明） */
  appendSystemPrompt?: string[]
  /** pi 格式的自定义工具定义（由 llama-studio 的工具适配而来） */
  customTools: ToolDefinition[]
  /** 会话创建完成后的回调（注册事件订阅用） */
  onReady?: (session: AgentSession) => void
}

export interface PiAgentBridge {
  session: AgentSession
  dispose: () => void
}

// 全局复用一个 ModelRuntime（认证/模型目录指向 llama-studio 自己的 agentDir，
// 不读用户的 ~/.pi/agent/auth.json、models.json）。端口每次启动变化，
// 每次 createSession 时用 registerProvider 覆盖 baseUrl 即可。
let modelRuntimePromise: Promise<ModelRuntime> | null = null
function getModelRuntime(agentDir: string): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = getPi().then(async (pi) => {
      mkdirSync(agentDir, { recursive: true })
      return pi.ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json'),
        allowModelNetwork: false,
        refreshOnCreate: false
      })
    })
  }
  return modelRuntimePromise
}

export async function createPiAgentBridge(options: PiAgentBridgeOptions): Promise<PiAgentBridge> {
  const { cwd, toolNames, customTools } = options
  const pi = await getPi()
  const agentDir = options.agentDir ?? pi.getAgentDir()
  const port = options.getPort()
  if (!port) throw new Error('未选择可用模型（无运行中的本地模型端口）')
  const contextWindow = options.getContextWindow?.() ?? 128000

  const modelRuntime = await getModelRuntime(agentDir)
  modelRuntime.registerProvider(LLAMA_STUDIO_PROVIDER_ID, {
    name: 'Llama Studio (Local)',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: 'openai-completions',
    apiKey: 'local', // 占位：本地无鉴权；pi 据此认为该 provider 已配置
    models: [
      {
        id: LLAMA_STUDIO_MODEL_ID,
        name: 'Local Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
        // 本地端点支持 stream_options.include_usage（llama.cpp 系），
        // 显式开启以免对本地 URL 的自动检测误判为不支持 → usage 缺失 → Token 记账失败
        compat: { supportsUsageInStreaming: true },
        ...(options.getExtraBody ? { samplingParams: options.getExtraBody() } : {})
      }
    ]
  })
  const model = modelRuntime.getModel(LLAMA_STUDIO_PROVIDER_ID, LLAMA_STUDIO_MODEL_ID)
  if (!model) throw new Error('本地模型注册失败（ModelRuntime.getModel 未找到）')

  const { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } = pi
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    appendSystemPrompt: options.appendSystemPrompt,
    // 不加载任何扩展/技能/提示模板/主题：这些是 pi TUI 的生态（用户 ~/.pi/agent 下的
    // status 等扩展在会话重建后会持有过期 ctx 崩溃，且与 llama-studio 的 UI 无关）。
    // 保留 contextFiles（AGENTS.md 逐级发现，对模型理解项目有帮助）。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true
  })
  await resourceLoader.reload()
  const sessionManager = SessionManager.inMemory(cwd)

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    // 本地模型：思考由模型自行输出 <think> 文本（content 通道）；不给 pi 发
    // reasoning 参数（thinkingLevel off），避免后端不识别 reasoning_effort 等字段
    thinkingLevel: 'off',
    resourceLoader,
    sessionManager,
    // 禁用 pi 的 auto-compaction：llama-studio 自己管理历史（持久化 + 手动 condense +
    // 每次重建会话注入完整历史），pi 的压缩只会多发一轮摘要请求且结果不落盘
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    customTools,
    tools: toolNames,
    noTools: 'builtin'
  })

  options.onReady?.(session)

  return {
    session,
    dispose: () => {
      try {
        session.dispose()
      } catch {
        /* 忽略重复释放 */
      }
    }
  }
}

export type { AgentSession, ToolDefinition }
