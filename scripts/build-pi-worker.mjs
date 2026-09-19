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
    // 静默：由 electron.vite.config.ts 的面板插件负责输出格式（失败信息走 catch）。
    logLevel: 'silent',
  })
} catch (err) {
  console.error('[build-pi-worker] 失败:', err)
  process.exit(1)
}
