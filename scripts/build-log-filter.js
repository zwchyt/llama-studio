/**
 * 构建日志的噪声过滤。
 *
 * 抽成独立模块是为了可测 —— 过滤器有状态（要把整块警告一起吃掉），
 * 而「误伤正常输出」比「漏过滤」严重得多，必须能单独验证。
 */

/**
 * 构建输出里要丢弃的噪声行：
 *   · 字体文件清单（.woff/.woff2/.ttf/.ttf2）
 *   · KaTeX 资源
 *   · Vite 的 "Use of eval in …" 提示
 *   · markstream-react 的 `/* @__PURE__ *​/` 注解位置不合法，Rollup 逐个文件报告
 *
 * 最后这类一条占 5 行：
 *     node_modules/.../Tooltip-xxx.js (1:1818): A comment
 *     （空行）
 *     "/* @__PURE__ *​/"
 *     （空行）
 *     in "node_modules/..." contains an annotation that Rollup cannot interpret …
 * 只过滤最后一行会留下 4 行孤儿，所以用 inPureBlock 标记把整块吃掉。
 * 这些注解不影响产物正确性（Rollup 只是删掉它们），纯刷屏。
 *
 * 返回一个有状态的过滤器：每行调一次，true = 丢弃。
 */
function makeNoiseFilter() {
  let inPureBlock = false
  return (line) => {
    if (inPureBlock) {
      if (/contains an annotation that Rollup cannot interpret/.test(line)) inPureBlock = false
      return true
    }
    // 不加 $ 锚点：Rollup 可能给这行上色，行尾会跟 ANSI 转义序列
    if (/:\s*A comment/.test(line)) {
      inPureBlock = true
      return true
    }
    return /\.(woff|ttf)2?\s|KaTeX_|Use of eval in/.test(line)
  }
}

/** 按行转发子进程输出，噪声行整行丢弃；残留的不完整行在 end 时补一次 */
function pipeLines(stream, out) {
  const isNoise = makeNoiseFilter()
  let buf = ''
  stream.on('data', (chunk) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!isNoise(line)) out.write(line + '\n')
    }
  })
  stream.on('end', () => {
    if (buf && !isNoise(buf)) out.write(buf)
  })
}

module.exports = { makeNoiseFilter, pipeLines }
