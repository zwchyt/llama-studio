// ── Agent 行为配置（集中化 · 轻量版）──
// 把原先散落在 AgentCodeView 里的阈值收敛到「单一来源」，便于按不同本地小模型调参，
// 无需改动循环代码。可选：从 localStorage('agentConfigOverrides') 合并覆盖，实现零重编译调参
// （例：在 DevTools 里 localStorage.setItem('agentConfigOverrides', '{"spinLimit":4}')）。
// 刻意保持简单：不做 Schema 校验 / env / 热重载（那是 atomic-agent 的生产级方案，本地场景无需）。

export interface AgentConfig {
  // ── 循环 ──
  maxTurns: number                // 工具调用轮次上限
  // ── 失败熔断（fuse/breaker）──
  maxToolFails: number            // 同一工具连续失败达此数 → 熔断
  failWindow: number              // 失败滚动窗口大小（最近 N 次工具执行）
  failWindowLimit: number         // 窗口内失败数达此值 → 熔断（防“换写法反复失败”）
  // ── 提问防抖 ──
  maxAskQuestion: number          // AskUserQuestion 累计调用上限
  // ── 原地打转 / 复读检测（⑥）──
  spinLimit: number               // 同一「工具+参数」成功调用重复达此数 → 熔断
  textSpinLimit: number           // 连续多轮助手正文完全相同达此数 → 停止
  textSpinMinLen: number          // 正文短于此长度不参与复读检测（防误伤）
  // ── 上下文预算 ──
  ctxDefault: number              // 取不到真实 n_ctx 时的兜底上下文大小
  maxOutput: number               // 与 chatStream 实际 max_tokens 一致
  ctxSafety: number               // 预留安全余量（token）
  projectMemoryInjectCap: number  // 项目记忆注入系统提示时的最大字符数
  // ── 渐进工具暴露（④）──
  compactRareTools: boolean       // 低频工具是否只注入精简 schema
  // ── Tracing 落盘（④ 本档）──
  traceToDisk: boolean            // 是否把每次工具执行的审计条目追加落盘，便于事后复现
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTurns: 40,
  maxToolFails: 3,
  failWindow: 6,
  failWindowLimit: 4,
  maxAskQuestion: 3,
  spinLimit: 3,
  textSpinLimit: 3,
  textSpinMinLen: 24,
  ctxDefault: 4096,
  maxOutput: 4096,
  ctxSafety: 256,
  projectMemoryInjectCap: 4000,
  compactRareTools: true,
  traceToDisk: true,
}

function loadAgentConfig(): AgentConfig {
  const cfg: AgentConfig = { ...DEFAULT_AGENT_CONFIG }
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('agentConfigOverrides') : null
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
