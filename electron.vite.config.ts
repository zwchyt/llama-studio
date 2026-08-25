import { resolve } from 'path'
import { statSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { createLogger, type Logger } from 'vite'

// ─────────────────────────────────────────────────────────────
// 终端可视化工具（非 TTY 时降级为纯文本，避免污染日志/CI）
// ─────────────────────────────────────────────────────────────
const TTY = !!process.stdout.isTTY
const esc = (code: string) => (TTY ? `\x1b[${code}m` : '')
const reset = esc('0')
const green = (s: string) => esc('32') + s + reset
const dim = (s: string) => esc('2') + s + reset

function gradStr(text: string, c1: [number, number, number], c2: [number, number, number]): string {
  if (!TTY) return text
  const chars = [...text]
  const n = chars.length
  return chars
    .map((ch, i) => {
      const t = n <= 1 ? 0 : i / (n - 1)
      const r = Math.round(c1[0] + (c2[0] - c1[0]) * t)
      const g = Math.round(c1[1] + (c2[1] - c1[1]) * t)
      const b = Math.round(c1[2] + (c2[2] - c1[2]) * t)
      return `\x1b[38;2;${r};${g};${b}m${ch}${reset}`
    })
    .join('')
}
const gradBar = (len: number, c1: [number, number, number], c2: [number, number, number]) =>
  gradStr('─'.repeat(len), c1, c2)

// 列宽对齐工具：按「可见宽度」(剥离 ANSI 转义) 进行补齐，确保表头与数据行严格对齐
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
function padv(s: string, n: number): string {
  const v = stripAnsi(s).length
  return s + ' '.repeat(Math.max(0, n - v))
}

// ─────────────────────────────────────────────────────────────
// 启动标题栏 + 列头（进程启动时打印一次）
// ─────────────────────────────────────────────────────────────
const APP_VERSION = 'v1.0.186'
const EV_VERSION = 'electron-vite 5.0.0'

// 启动期 spinner（TTY 下旋转；非 TTY 不启动）
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinTimer: ReturnType<typeof setInterval> | null = null
let spinLabel = 'building bundles…'

function startSpinner() {
  if (!TTY) return
  if (spinTimer) return
  let i = 0
  spinTimer = setInterval(() => {
    process.stdout.write('\r\x1b[K' + FRAMES[i++ % FRAMES.length] + ' ' + spinLabel)
  }, 80)
}
function stopSpinner() {
  if (spinTimer) {
    clearInterval(spinTimer)
    spinTimer = null
  }
  if (TTY) process.stdout.write('\r\x1b[K')
}

// 先清 spinner 行，再单独打印一行面板行，最后（如需）在新行重启 spinner
function printRow(text: string, restart: boolean, nextLabel?: string) {
  stopSpinner()
  console.log(text)
  if (restart) {
    if (nextLabel) spinLabel = nextLabel
    startSpinner()
  }
}

function printBanner() {
  const title = `▓▓ llama-studio   dev mode · ${APP_VERSION} · ${EV_VERSION}`
  const inner = title + ' '
  const rule = gradBar(inner.length, [88, 180, 255], [180, 120, 255])
  
  // 定义颜色
  const colors = {
    process: '\x1b[36m',    // 青色
    status: '\x1b[33m',     // 黄色
    output: '\x1b[32m',     // 绿色
    time: '\x1b[35m',       // 紫色
    reset: '\x1b[0m'        // 重置
  }
  
  // 列宽（表头与数据行共用，保证上下对齐）
  const PROC_W = 8
  const STATUS_W = 13
  const OUTPUT_W = 12
  const SEP = '  '

  const head =
    SEP +
    padv(`${colors.process}process${colors.reset}`, PROC_W) +
    SEP +
    padv(`${colors.status}status${colors.reset}`, STATUS_W) +
    SEP +
    padv(`${colors.output}output${colors.reset}`, OUTPUT_W) +
    SEP +
    `${colors.time}time${colors.reset}`

  const dash =
    SEP +
    '─'.repeat(PROC_W) +
    SEP +
    '─'.repeat(STATUS_W) +
    SEP +
    '─'.repeat(OUTPUT_W) +
    SEP +
    '─'.repeat(4)

  console.log('\n' + '┌' + rule + '┐\n' + '│' + gradStr(inner, [205, 225, 255], [185, 145, 255]) + '│\n' + '└' + rule + '┘\n' + '\n' + head + '\n' + dash + '\n')
  startSpinner()
}

printBanner()

// 把 vite 默认构建横幅重绘为面板行；其余 info 透传给默认 logger
function makeCustomLogger(): Logger {
  const base = createLogger('info')
  return {
    ...base,
    info(msg, opts) {
      const s = typeof msg === 'string' ? msg : String(msg)

      // 构建开始行 / 完成计时行 / 产物体积行 → 抑制（面板行由 build-panel 插件打印）
      if (/building (ssr )?bundle/i.test(s)) return
      if (/built in/i.test(s)) return
      if (/out[/\\](main|preload)[/\\]index\.js/i.test(s)) return

      // renderer dev server 就绪 → 停 spinner 并打印面板行
      if (/dev server running for the electron renderer/i.test(s)) {
        stopSpinner()
        console.log('  ' + padv('renderer', 8) + '  ' + green('✓ dev server ready') + ' (hot reload on)')
        return
      }

      base.info(msg, opts)
    },
  } as Logger
}

// main/preload 构建面板行（从 vite 构建钩子取真实耗时与产物体积，不依赖日志字符串格式）
function makeBuildPanel(proc: 'main' | 'preload') {
  let start = 0
  return {
    name: `ls-build-panel-${proc}`,
    apply: 'build' as const,
    buildStart() {
      start = Date.now()
    },
    closeBundle() {
      let size = ''
      try {
        const bytes = statSync(resolve('out', proc, 'index.js')).size
        size = (bytes / 1024).toFixed(1) + ' kB'
      } catch {
        /* 产物尚未落盘时忽略 */
      }
      const ms = `${Date.now() - start}ms`
      const SEP = '  '
      const PROC_W = 8
      const STATUS_W = 13
      const OUTPUT_W = 12
      const row =
        SEP +
        padv(proc, PROC_W) +
        SEP +
        padv(green('✓ done'), STATUS_W) +
        SEP +
        padv(size, OUTPUT_W) +
        SEP +
        ms
      if (proc === 'main') {
        printRow(row, true, 'building preload…')
      } else {
        printRow(row, true, 'launching electron app…')
        console.log('  ' + dim('✓ all bundles ready'))
      }
    },
  }
}

export default defineConfig({
  // 注：electron-vite 自身的 "built successfully" / "-----" / "starting electron app"
  // 等提示由 CLI 的 `--logLevel silent` 抑制（见 package.json 的 dev/preview 脚本），
  // 下面的自定义横幅负责统一的面板化输出。

  main: {
    customLogger: makeCustomLogger(),
    plugins: [makeBuildPanel('main')],
  },
  preload: {
    customLogger: makeCustomLogger(),
    plugins: [makeBuildPanel('preload')],
  },
  renderer: {
    customLogger: makeCustomLogger(),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [
      react(),
      {
        name: 'suppress-vite-url',
        configureServer(server) {
          server.printUrls = () => {}
        },
      },
    ],
  },
})
