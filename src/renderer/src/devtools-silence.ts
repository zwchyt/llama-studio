// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：开发环境屏蔽 React 的「Download the React DevTools」提示                 ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// ReactDOM 初始化时会调 injectInternals()：钩子不存在就返回 false，随后打印那条提示
// （react-dom-client 的 development 构建里，`if (!injectInternals(...) && ...)` 才 console.info）。
//
// 这不是安装 DevTools，只是让它别提示 —— 调试时依然没有 React 面板。
// 生产构建里 import.meta.env.DEV 会被静态替换成 false，整块代码随之被 tree-shake 掉。
//
// 必须在 react-dom 之前求值：ReactDOM 在**模块求值阶段**就读这个钩子，晚一步拦不住。
// 所以本文件由 main.tsx 作为第一个 import 引入。

if (import.meta.env.DEV) {
  // ① 在 React 加载前占位钩子。React 官方支持的 opt-out：injectInternals 的第一道判断
  //    就是 `if (hook.isDisabled) return true`，提示与整套 DevTools 集成都会跳过。
  //    已有真实钩子（装了扩展）时不覆盖，让它照常工作。
  const w = window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { isDisabled?: boolean } }
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || { isDisabled: true }

  // ② 兜底：万一钩子因打包器调整了模块求值顺序而没赶上，提示仍会走 console.info。
  //    只拦这一条，其余原样透传。
  const origInfo = console.info
  console.info = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes('Download the React DevTools')) return
    origInfo(...args)
  }
}
