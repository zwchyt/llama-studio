// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ canvas 桩 —— 让 jsdom 走「canvas 不可用」的官方降级分支                        ║
// ║                                                                            ║
// ║ 背景：package.json 用 overrides 把 canvas 指向本桩，避免引入需要原生编译的      ║
// ║       canvas 依赖（工程里没有任何业务代码用到 canvas，只有 jsdom 会 require）。  ║
// ║                                                                            ║
// ║ 之前的写法是 `module.exports = {}`，这是**错的**：                             ║
// ║   jsdom/lib/jsdom/utils.js 里是                                             ║
// ║       try { exports.Canvas = require("canvas") } catch { exports.Canvas = null }║
// ║   空对象是 truthy，于是 jsdom 认为「canvas 可用」，接着在                       ║
// ║   HTMLImageElement-impl 里执行 `new Canvas.Image()` —— 而 Canvas.Image 是       ║
// ║   undefined，直接抛 TypeError。                                               ║
// ║                                                                            ║
// ║   后果：jsdom 里任何带 <img> 的渲染都会崩；React 会把它当组件错误处理掉，        ║
// ║   导致**测试静默地不完整**（例如 XSS 载荷库里含 <img> 的那几条根本没渲染完），    ║
// ║   从而得出误导性的安全结论。                                                   ║
// ║                                                                            ║
// ║ 正确做法：主动抛错，命中 jsdom 的 catch → Canvas = null → `if (!Canvas) return` ║
// ║   提前返回。这样 jsdom 不解码图片、不触发 error 事件，测试环境干净可预测。        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

throw new Error(
  'canvas is intentionally unavailable: stubbed out by scripts/canvas-stub. ' +
  'jsdom detects this via its try/catch and disables image decoding (Canvas = null).',
)
