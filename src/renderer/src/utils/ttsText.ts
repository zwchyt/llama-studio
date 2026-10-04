// ══════════════════════════════════════════════════════════
// 朗读文本预处理。模型输出是 Markdown，原样喂给 TTS 会把符号念成名称
// （「左括号」「星号」「破折号」「斜杠」「书名号」）。策略：
//   · 结构性内容（代码块、公式、图片）整块摘掉，只留一次停顿；
//   · 强调符 / 列表符 / 井号等纯标记删掉，文字照常念；
//   · 符号性标点换成中文逗号 —— 两种引擎都读成短停顿，比删掉更自然；
//   · 句末 。！？ 保留，引擎靠它做长停顿。
// 清洗结果保留换行：edge 路径把换行翻成 <break>，system 路径按句切条。
// ══════════════════════════════════════════════════════════

/** 一次短停顿 */
const PAUSE = '，'

/** Markdown / 符号 → 可朗读正文 */
export function prepareTtsText(raw: string): string {
  if (!raw) return ''
  let s = raw

  // 流式中途代码块可能还没闭合：奇数个 ``` 说明尾部是半截代码，整块丢掉
  const fences = s.split('```')
  if (fences.length % 2 === 0) s = fences.slice(0, -1).join('```')

  // 代码块 / 公式 / 图片：念出来只是噪声，换成停顿
  s = s.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, PAUSE)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\$\$[\s\S]*?\$\$/g, PAUSE)
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, PAUSE)
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, PAUSE)

  // 链接只留可见文字；URL 里全是斜杠点号，念不成东西，换成「链接」二字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?[a-z][^>]*>/gi, '')
  s = s.replace(/https?:\/\/\S+/g, '链接')

  // 行首标记：分隔线、标题井号、引用、无序 / 有序列表符
  s = s.replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})$/gm, '\n')
  s = s.replace(/^ {0,3}#{1,6}\s*/gm, '')
  s = s.replace(/^ {0,3}>+ ?/gm, '')
  s = s.replace(/^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '')

  // 表格：分隔行删掉，竖线换成停顿（不然念成「竖线」）
  s = s.replace(/^ {0,3}\|? *:?-{2,}:?(?: *\| *:?-{2,}:?)+ *\|?$/gm, '')
  s = s.replace(/[ \t]*\|[ \t]*/g, PAUSE)

  // 成对强调符只留文字
  s = s.replace(/(\*\*\*|___|\*\*|__|~~)(\S[\s\S]*?)\1/g, '$2')
  // 数字之间的关系得念出词，别一删了之（日期先单独处理，免得念成「2024到05」）
  s = s.replace(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g, (_m, y, mo, d) => `${y}年${Number(mo)}月${Number(d)}日`)
  s = s.replace(/(\d)\s*[x×*]\s*(\d)/g, '$1乘$2')
  s = s.replace(/(\d)\s*[-~～]\s*(\d)/g, '$1到$2')
  // 剩下的星号 / 下划线 / 波浪号 / 反引号没有读音，一律删
  s = s.replace(/[*_~～`]/g, '')
  // 破折号 → 停顿；连字符删掉
  s = s.replace(/—+|–/g, PAUSE)
  s = s.replace(/-/g, '')

  // 括号类：符号不念，位置补停顿
  s = s.replace(/[（）()【】〔〕《》〈〉「」『』{}]/g, PAUSE)
  // 顿号 / 冒号 / 分号 / 省略号 / 间隔号 / 斜杠：统一成停顿
  s = s.replace(/[、：；…·・\/]/g, PAUSE)
  // 中文弯引号删掉；ASCII 引号留着，它是英文单词的一部分（don't 不能写成 dont）
  s = s.replace(/[“”‘’]/g, '')
  // 其余无读音意义的符号
  s = s.replace(/[#%&+=@^|\\$]/g, '')
  s = s.replace(/\p{Extended_Pictographic}/gu, '')

  // 收尾：停顿不叠加，句末标点后的停顿删掉，空白归一
  s = s.replace(/，+([。！？!?])/g, '$1')
  s = s.replace(/([。！？!?])，+/g, '$1')
  s = s.replace(/，+/g, PAUSE)
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.replace(/^[\s，]+|[\s，]+$/g, '')
}

/**
 * 按句末标点切句，供系统语音逐句朗读。
 * 整篇塞进一条 utterance 会被 Chromium 中途掐断，分句顺带换来句间自然停顿。
 * maxLen 是兜底上限：没有标点的长串按长度硬切。
 */
export function splitTtsSentences(text: string, maxLen = 80): string[] {
  const parts: string[] = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if ('。！？!?；;\n'.includes(ch)) {
      parts.push(buf)
      buf = ''
    }
  }
  if (buf) parts.push(buf)

  const out: string[] = []
  for (const part of parts) {
    const t = part.trim()
    // 只剩标点的片段没有朗读价值，还会多一次空停顿
    if (!/[\p{L}\p{N}]/u.test(t)) continue
    for (let i = 0; i < t.length; i += maxLen) out.push(t.slice(i, i + maxLen))
  }
  return out
}
