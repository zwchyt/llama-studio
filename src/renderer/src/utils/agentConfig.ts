// ── Agent 行为配置（集中化 · 轻量版）──
// 把原先散落在 AgentCodeView 里的阈值收敛到「单一来源」，便于按不同本地小模型调参，
// 无需改动循环代码。可选：从 localStorage('agentConfigOverrides') 合并覆盖，实现零重编译调参
// （例：在 DevTools 里 localStorage.setItem('agentConfigOverrides', '{"spinLimit":4}')）。
// 刻意保持简单：不做 Schema 校验 / env / 热重载（那是 atomic-agent 的生产级方案，本地场景无需）。

export interface AgentConfig {
  // ── 上下文预算 ──
  ctxDefault: number              // 取不到真实 n_ctx 时的兜底上下文大小
  maxOutput: number               // 与 chatStream 实际 max_tokens 一致
  ctxSafety: number               // 预留安全余量（token）
  // ── 认知地图（模块一 · 上下文感知引擎）──
  codeMapEnabled: boolean         // 开关：项目打开时后台构建认知地图 + 写工具成功后同步失效
  ctxImportanceEnabled: boolean   // 开关：重要性裁剪——同文件重复 Read 结果只保最新、旧版折叠为占位
  // ── 代码混合检索（模块三 · RAG，阶段 3.1/3.2）──
  codeSearchEnabled: boolean      // 开关：注册 CodeSearch 工具（BM25 词法 + 符号精确混合检索）
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  ctxDefault: 4096,
  maxOutput: 4096,
  ctxSafety: 256,
  codeMapEnabled: true,
  ctxImportanceEnabled: true,
  codeSearchEnabled: true,
}

const OVERRIDES_KEY = 'agentConfigOverrides'

/** 当前生效的全部覆盖项（设置页初始化用；只读快照） */
export function getAgentConfigOverrides(): Partial<AgentConfig> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(OVERRIDES_KEY) : null
    return raw ? JSON.parse(raw) as Partial<AgentConfig> : {}
  } catch { return {} }
}

/**
 * 运行时改写单项配置：写 localStorage 并**就地更新单例**。
 * 原先只有 loadAgentConfig() 在模块加载时读一次，改了要重启才生效；就地更新让
 * 已经 import 了 agentConfig 的读取方（useAgentLoop / contextBudget …）
 * 下一次读取就拿得到新值，无需重载。
 */
export function setAgentConfigOverride<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]): void {
  agentConfig[key] = value
  try {
    const cur = getAgentConfigOverrides()
    cur[key] = value
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(cur))
  } catch { /* 存储不可用时仅本次运行生效 */ }
}

function loadAgentConfig(): AgentConfig {
  const cfg: AgentConfig = { ...DEFAULT_AGENT_CONFIG }
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(OVERRIDES_KEY) : null
    if (raw) {
      const o = JSON.parse(raw) as Partial<Record<keyof AgentConfig, unknown>>
      for (const k of Object.keys(cfg) as (keyof AgentConfig)[]) {
        const v = o[k]
        // 仅接受类型一致的覆盖项，忽略非法值，避免坏配置污染循环
        if (v !== undefined && typeof v === typeof cfg[k]) (cfg as unknown as Record<string, unknown>)[k] = v
      }
    }
  } catch { /* 覆盖项解析失败则使用默认值 */ }
  return cfg
}

// 单一实例：模块加载时读取一次（含 localStorage 覆盖）。全应用共享同一份配置。
export const agentConfig: AgentConfig = loadAgentConfig()
