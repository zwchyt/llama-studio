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
import type { RemoteEndpoint } from '../../../shared/types'

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
  /** 远程端点：填了就取代本机端口，pi 直接按这个 base URL / 协议 / key 发请求 */
  endpoint?: RemoteEndpoint
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
  /** 模型支持图像输入时置 true：pi 依据 input 模态决定是否下发工具结果里的图片 */
  vision?: boolean
  /** 追加到 system prompt 的工具使用指导（如计划工具说明） */
  appendSystemPrompt?: string[]
  /** 整段替换 pi 的默认 system prompt（不是追加）。纯聊天模式用它，
      因为 pi 默认提示词里写着「你是 pi 里的编码助手」以及「你还可能有其它自定义工具」——
      不替换的话，即使一个工具都没注册，模型也会以为自己能调工具。 */
  systemPrompt?: string
  /** 不加载 AGENTS.md 等逐级发现的上下文文件（纯聊天模式用，项目规则与普通对话无关） */
  noContextFiles?: boolean
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

/**
 * 预热 pi SDK 运行时：提前加载 pi 系 ESM 模块 + 创建 ModelRuntime，
 * 把首次对话时的一次性初始化成本移出交互路径。全局缓存保证与
 * createPiAgentBridge 共用同一实例；失败静默（后续正常路径会重新初始化）。
 */
export function warmupPiBridge(agentDir: string): Promise<void> {
  return Promise.all([getPi(), getModelRuntime(agentDir)]).then(() => undefined)
}

export async function createPiAgentBridge(options: PiAgentBridgeOptions): Promise<PiAgentBridge> {
  const { cwd, toolNames, customTools } = options
  const pi = await getPi()
  const agentDir = options.agentDir ?? pi.getAgentDir()
  const port = options.getPort()
  // 远程端点（自定义 base URL + 协议 + key）：给了它就不再看本机端口
  const ep = options.endpoint
  if (!port && !ep) throw new Error('未选择可用模型（既没有运行中的服务，也没有填写端点）')
  const contextWindow = ep?.contextWindow ?? options.getContextWindow?.() ?? 128000
  const modelId = ep?.modelId?.trim() || LLAMA_STUDIO_MODEL_ID

  const modelRuntime = await getModelRuntime(agentDir)
  // H-11 防御性加固：provider id 带 port 后缀，杜绝未来多会话/多端口时同名覆盖 baseUrl
  // （当前渲染端单活跃会话实际不可达；条目按端口数有界，dispose 不注销可接受）。
  // 远程端点按 base URL 生成后缀，同样只含 [a-z0-9-]，多条远程卡互不覆盖。
  const providerId = ep
    ? `${LLAMA_STUDIO_PROVIDER_ID}-remote-${ep.baseUrl.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(-48)}`
    : `${LLAMA_STUDIO_PROVIDER_ID}-${port}`
  // supportsUsageInStreaming 是为 llama.cpp / OpenAI 兼容端点特调的（显式发
  // stream_options.include_usage，否则 usage 缺失 → Token 记账失败）。
  // Anthropic 协议的 usage 本来就在 message_start / message_delta 里带回来，不该塞这个开关。
  const openAiStyle = !ep || ep.api !== 'anthropic-messages'
  modelRuntime.registerProvider(providerId, {
    name: ep ? ep.baseUrl : 'Llama Studio (Local)',
    baseUrl: ep ? ep.baseUrl : `http://127.0.0.1:${port}/v1`,
    api: ep ? ep.api : 'openai-completions',
    // 本机无鉴权时 'local' 只是让 pi 认为该 provider 已配置
    apiKey: ep?.apiKey?.trim() || 'local',
    models: [
      {
        id: modelId,
        name: ep ? modelId : 'Local Model',
        reasoning: true,
        // 工具结果里的图片（browser_screenshot）只有在该模态被声明时才会发给模型
        input: (ep ? ep.vision === true : options.vision) ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
        ...(openAiStyle ? { compat: { supportsUsageInStreaming: true } } : {}),
        ...(options.getExtraBody ? { samplingParams: options.getExtraBody() } : {})
      }
    ]
  })
  const model = modelRuntime.getModel(providerId, modelId)
  if (!model) throw new Error(`模型注册失败（ModelRuntime 里没有 ${modelId}）`)

  const { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } = pi
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // 注意这两个是不同的东西：systemPrompt 整段替换 pi 的默认提示词，appendSystemPrompt 只追加。
    // 工具描述与「你还可能有其它自定义工具」那句在默认提示词里，只清 appendSystemPrompt 是清不掉的。
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    noContextFiles: options.noContextFiles,
    // 不加载任何扩展/技能/提示模板/主题：这些是 pi TUI 的生态（用户 ~/.pi/agent 下的
    // status 等扩展在会话重建后会持有过期 ctx 崩溃，且与 llama-studio 的 UI 无关）。
    // 默认保留 contextFiles（AGENTS.md 逐级发现，对模型理解项目有帮助），
    // 纯聊天模式下由 noContextFiles 关掉。
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
    // 每次重建会话注入完整历史），pi 的压缩只会多发一轮摘要请求且结果不落盘。
    // 同时关掉图片自动缩放：它由 photon（WASM）实现，而 photon_rs_bg.wasm 没随
    // piWorker.mjs 一起打包，loadPhoton 找不到 wasm 只会返回 null，于是 processImage
    // 对任何图片都判 ok:false —— 用户发的图在拼请求体之前就被整体丢弃，模型只看得到
    // 一句「Image omitted」提示。原样透传即可（llama.cpp 官方 webui 也直接发原始字节）。
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      images: { autoResize: false }
    }),
    customTools,
    // 工具白名单：只含 llama-studio 的自研工具名，pi 内置工具
    // （小写 read/bash/edit/write/grep/find/ls）因此不会注册/激活。
    tools: toolNames
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
