// 图片在正文里的行内记号：只负责解析，不再负责生成。
//
// 历史沿革：记号（`图片:文件名`）原本是「图片与正文混排」的实现方式——输入框把记号当普通
// 文字插进正文，再按量出的记号坐标把胶囊盖上去。现在输入框改成「图片胶囊自成一整行、
// 正文在下面」，不再往正文里插任何记号，于是本文件只剩解析这一件事：
//   · 旧会话里已经存下的正文仍带记号，消息气泡据此把胶囊排回用户当初插入的位置；
//   · 新消息没有记号，气泡会把没被正文认领的图片接着正文排成胶囊。
// 形式 图片:文件名 —— 不带括号：记号里带的字形就是胶囊盖不住时会露出来的东西，
// 括号一露便是「把胶囊括起来」的那对角。名字里的空白换成 _，记号便以空格为界。
// 〔名〕〔图片:名〕〔🖼 名〕是早期写法，解析时一并认。同名多张按出现顺序与附件一一对应。

const MARKER_RE = /〔(?:🖼\s*|图片:)?([^〕]*)〕|图片[:：]([^\s〔〕]{1,40})/g

export type ImageMarkerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; name: string; raw: string; start: number }

/** 正文按记号切成交错片段：文字段原样保留，记号段带文件名、记号原文与起始下标 */
export function splitByImageMarkers(text: string): ImageMarkerSegment[] {
  const out: ImageMarkerSegment[] = []
  let last = 0
  for (const m of text.matchAll(MARKER_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) })
    out.push({ kind: 'image', name: m[1] ?? m[2] ?? '', raw: m[0], start: idx })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
