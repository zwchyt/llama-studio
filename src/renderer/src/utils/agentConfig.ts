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
  // ── Bash 连续调用频率限制 ──
  bashConsecutiveWarn: number     // 连续 Bash 调用（无实质写操作间隔）达此数 → 追加警告
  bashConsecutiveFuse: number     // 连续 Bash 调用达此数 → 硬性熔断
  bashBaseCmdLimit: number        // 同一基础命令词（如 dir/type/git）累计调用达此数 → 警告
  // ── 工具「执行中」状态最小显示时长 ──
  minExecDisplayMs: number        // 快工具执行完后保持「执行中」直到满此时长再显示「完成」（慢工具不额外等待）
  // ── 上下文预算 ──
  ctxDefault: number              // 取不到真实 n_ctx 时的兜底上下文大小
  maxOutput: number               // 与 chatStream 实际 max_tokens 一致
  ctxSafety: number               // 预留安全余量（token）
  projectMemoryInjectCap: number  // 项目记忆注入系统提示时的最大字符数
  // ── 渐进工具暴露（④）──
  compactRareTools: boolean       // 低频工具是否只注入精简 schema
  // ── Tracing 落盘（④ 本档）──
  traceToDisk: boolean            // 是否把每次工具执行的审计条目追加落盘，便于事后复现
  // ── 认知地图（模块一 · 上下文感知引擎）──
  codeMapEnabled: boolean         // 开关：项目打开时后台构建认知地图 + 写工具成功后同步失效
  contextPackEnabled: boolean     // 开关：发送前按锚点查地图、注入「参考材料」上下文包（阶段 1.3）
  contextPackRatio: number        // 上下文包占 prompt 预算的比例上限（0~1）
  ctxImportanceEnabled: boolean   // 开关：重要性裁剪——同文件重复 Read 结果只保最新、旧版折叠为占位
  // ── 短期台账（模块二 · 记忆系统）──
  toolLedgerEnabled: boolean      // 开关：只读工具跨轮重复调用命中台账缓存时直接返回、不重复执行
  ledgerResultCap: number         // 台账单条缓存结果的最大字符数（超长结果不缓存，避免内存膨胀）
  condenseFactsEnabled: boolean   // 开关：压缩时机械提取「结构化事实附录」逐字保留，不经 LLM 转写（阶段 2.2）
  // ── 代码混合检索（模块三 · RAG，阶段 3.1/3.2）──
  codeSearchEnabled: boolean      // 开关：注册 CodeSearch 工具（BM25 词法 + 符号精确混合检索）
  // ── 长期记忆（模块二 · 阶段 2.3）──
  longTermMemoryEnabled: boolean  // 开关：分类条目沉淀（四触发点）+ 注入侧升级 + 矛盾仲裁
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
  bashConsecutiveWarn: 4,
  bashConsecutiveFuse: 7,
  bashBaseCmdLimit: 5,
  minExecDisplayMs: 2000,
  ctxDefault: 4096,
  maxOutput: 4096,
  ctxSafety: 256,
  projectMemoryInjectCap: 4000,
  compactRareTools: true,
  traceToDisk: true,
  codeMapEnabled: true,
  contextPackEnabled: true,
  contextPackRatio: 0.2,
  ctxImportanceEnabled: true,
  toolLedgerEnabled: true,
  ledgerResultCap: 16000,
  condenseFactsEnabled: true,
  codeSearchEnabled: true,
  longTermMemoryEnabled: true,
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
