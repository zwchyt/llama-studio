// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：实时语音回合 → 会话消息（纯函数）                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 两个职责：
//   ① 把语音回合合并进消息列表（按 id 幂等）；
//   ② 认得出「占位/报错文案」——这些只是给眼睛看的，不能当作对话内容发给模型。

import type { AgentMessage } from '../../../../../shared/types'
import type { RealtimeTurn } from '../hooks/useRealtimeVoice'

/** 语音回合在消息列表里用的占位文案（还没转写出文字时显示） */
export const RT_PLACEHOLDER = '语音输入（识别中…）'

/** 这些文案是界面状态，不是用户说的话：拼历史时必须剔掉，否则模型会看到「语音输入（识别中…）」 */
const META_RE = /^语音输入（(识别中|未识别到内容|识别失败|未转写|未配置本地识别模型|音频写入失败)/

export function isRealtimeMetaContent(content: string): boolean {
  return META_RE.test(content.trim())
}

/** 把实时语音的回合合并进消息列表。按 id 幂等：重复执行只更新内容、不会重复插入；
 *  返回原数组表示「没有任何变化」，调用方据此跳过写回，避免无谓的重渲染与落盘。 */
export function mergeRealtimeTurns(
  messages: AgentMessage[],
  turns: RealtimeTurn[],
  run: string,
  modelLabel: string
): AgentMessage[] {
  let out = messages
  let changed = false
  const fork = (): void => {
    if (!changed) {
      out = out.slice()
      changed = true
    }
  }
  // 只为语音回合建索引，避免每条回合都全表扫描；插入会让下标错位，插入后作废重建
  let index: Map<string, number> | null = null
  const idxOf = (id: string): number => {
    if (!index) {
      index = new Map()
      for (let i = 0; i < out.length; i++) {
        const mid = out[i]!.id
        if (mid.startsWith('rt-')) index.set(mid, i)
      }
    }
    return index.get(id) ?? -1
  }

  for (const t of turns) {
    const text = t.text.trim()
    // 用户这一轮已经说完、但文字还没回来：先放占位气泡，等转写到了再替换。
    // 模型回合不占位——它还没出字就没什么可显示的。
    const content = text || (t.role === 'user' ? RT_PLACEHOLDER : '')
    if (!content) continue
    const id = `rt-${run}-${t.id}`
    const at = idxOf(id)
    if (at >= 0) {
      if (out[at]!.content === content) continue
      fork()
      out[at] = { ...out[at]!, content }
      continue
    }
    const msg: AgentMessage = t.role === 'assistant'
      ? { id, role: 'assistant', content, modelLabel }
      : { id, role: 'user', content }
    // 用户那句可能比回复晚到：插到同轮回复之前，保证「先问后答」
    const aIdx = t.role === 'user' ? idxOf(`rt-${run}-a${t.round}`) : -1
    fork()
    if (aIdx >= 0) out.splice(aIdx, 0, msg)
    else out.push(msg)
    index = null // 下标整体后移，作废重建
  }
  return changed ? out : messages
}
