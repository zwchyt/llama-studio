// pi-agent utility process 的独立打包脚本。
//
// 背景：pi 系包（@earendil-works/pi-coding-agent 等）是 ESM-only，模块求值会同步
// 阻塞事件循环数秒。方案 1 把它整体搬进 Electron utility process（独立进程），主
// 进程只做消息转发。electron-vite 的 main 构建是单产物 CJS（sandbox preload 要求），
// 不支持多输出，因此 piWorker 单独用 esbuild 打包成 ESM（.mjs）。
//
// 产出：out/main/piWorker.mjs（ESM，含全部 pi 依赖，外部仅保留 electron/node 内建）。
// 主进程通过 utilityProcess.fork(join(__dirname, 'piWorker.mjs')) 拉起。
//
// 用法：node scripts/build-pi-worker.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'out/main/piWorker.mjs')
mkdirSync(dirname(outFile), { recursive: true })

try {
  await build({
    entryPoints: [join(root, 'src/main/piWorker.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    minify: false,
    // pi 系包全部内联进 bundle（它们是 ESM-only，主进程 CJS 无法 require）。
    // electron 与 node 内建模块保持外部（utility process 运行时由 Electron 提供）。
    external: ['electron'],
    // node: 前缀的内建模块 esbuild 在 platform:'node' 下自动外部化。
    //
    // ── 为什么必须补一个 require ──
    // 打进 bundle 的 CJS 依赖用的是**裸**内建名（`require("child_process")`，没有 node:
    // 前缀），例如 cross-spawn（pi SDK 的 utils/child-process.js 引它）与
    // google-auth-library。esbuild 在 ESM 产物里把它们转成 __require 垫片，而垫片是
    //   typeof require !== "undefined" ? require : throw new Error('Dynamic require of ...')
    // —— ESM 里没有 require，于是运行时直接抛
    //   Error: Dynamic require of "child_process" is not supported
    // 当前产物里有 114 处这类调用（fs / path / crypto / stream / child_process …），
    // 只要走到哪个就炸哪个，属系统性打包问题而非单点。
    // 用 createRequire 在模块作用域补一个真实 require，垫片就会走它（相对本 .mjs 解析），
    // 全部 114 处一并可用。
    // 注意：banner 必须是**词法声明**而不是挂到 globalThis —— 垫片的 typeof 检查在
    // 模块作用域求值，词法绑定才会被它看到；且 banner 会被 esbuild 放在产物最顶端，
    // 早于垫片定义，不存在 TDZ 问题（改完请确认产物里 const require 在 var __require 之前）。
    banner: {
      js: [
        "import { createRequire as __piCreateRequire } from 'node:module';",
        "const require = __piCreateRequire(import.meta.url);",
      ].join('\n'),
    },
    // 静默：由 electron.vite.config.ts 的面板插件负责输出格式（失败信息走 catch）。
    logLevel: 'silent',
  })
} catch (err) {
  console.error('[build-pi-worker] 失败:', err)
  process.exit(1)
}
