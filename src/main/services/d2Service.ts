// D2 图表渲染服务（主进程）。
//
// 为什么在主进程渲染而不是渲染进程：@terrastruct/d2 的 WASM 运行时（wasm_exec）
// 会把字符串当 JS 执行（eval/new Function），渲染进程的 CSP 刻意不放行 'unsafe-eval'
// （Electron 安全检查明令反对），Worker 链路必被拦。主进程是 Node 环境、无 CSP 约束，
// 且 D2 类内部自带 Worker 线程（node:worker_threads），不会阻塞主进程事件循环——
// 此路径已用 Node 构建端到端验证过（compile → render → 自包含 SVG）。
//
// 引擎懒加载单例：包 58MB（含 WASM），首次用到才 import；实例复用，salt 自增
// 保证同文档多张图的 SVG 内部 ID 唯一。

type D2Module = typeof import('@terrastruct/d2')

let d2ImportPromise: Promise<D2Module> | null = null
let d2Instance: InstanceType<D2Module['D2']> | null = null
let saltSeq = 0

async function getD2(): Promise<InstanceType<D2Module['D2']>> {
  if (!d2ImportPromise) {
    d2ImportPromise = import('@terrastruct/d2').catch((error) => {
      d2ImportPromise = null
      throw error
    })
  }
  const mod = await d2ImportPromise
  if (typeof mod.D2 !== 'function') {
    throw new Error(`D2 类缺失（模块互操作异常，实际导出：${Object.keys(mod).join(', ') || '（空）'}）`)
  }
  if (!d2Instance) d2Instance = new mod.D2()
  return d2Instance
}

/** 渲染 D2 源码为自包含 SVG 字符串；失败抛错（调用方转成 error 字段）。 */
export async function renderD2Svg(source: string): Promise<string> {
  const d2 = await getD2()
  const res = await d2.compile(source)
  const diagram = res?.diagram ?? res
  const out = await d2.render(diagram, { salt: `d2-${++saltSeq}` })
  if (typeof out !== 'string' || !out.includes('<svg')) throw new Error('D2 输出为空')
  return out
}
