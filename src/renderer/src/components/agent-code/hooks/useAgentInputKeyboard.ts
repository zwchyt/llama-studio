// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：useAgentInputKeyboard —— 输入框键盘处理与 onChange 补全检测             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx 的 handleKeyDown / handleInputChange 与 atQueryRef
// （逻辑与注释未变）：
//   · handleKeyDown      —— IME 组合防护、退格删胶囊、/命令浮层按键接管、回车发送、
//                           ↑↓ 翻历史
//   · handleInputChange  —— 更新文本 + 自动增高，并检测 /命令 与 @ 文件补全触发
//
// 依赖注入采用「整域透传」：inputDomain / hintsDomain 直接传各 hook 的返回值；
// handleSend 由循环域注入，workspaceDir 取当前项目工作目录。

import React, { useCallback, useEffect, useRef } from 'react'
import type { RichValue } from '../agent-input/RichInput'
import type { useAgentInput } from './useAgentInput'
import type { useAgentInputHints } from './useAgentInputHints'

export function useAgentInputKeyboard({
  inputDomain, hintsDomain, handleSend, workspaceDir,
}: {
  inputDomain: ReturnType<typeof useAgentInput>
  hintsDomain: ReturnType<typeof useAgentInputHints>
  handleSend: (overrideText?: string) => void
  workspaceDir: string
}) {
  const {
    input, setInput, editorRef, setChips,

    autoResize, recallHistory,
  } = inputDomain
  const {
    atQuery, setAtQuery, atAnchorRef, slashQuery, setSlashQuery,
    slashList, slashIdx, setSlashIdx, ensureWorkspaceFiles,
    detectAt, filterAtFiles, detectSlash, onPickSlash,
  } = hintsDomain

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME 组合输入中（中文/日文输入法选词）不触发发送，避免误发消息
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // /命令 补全浮层激活时，方向键/回车/Tab/Esc 优先用于选择，绝不发送、不翻历史
    if (slashQuery !== null) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashQuery(null)
        return
      }
      if (slashList.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashIdx(i => (i + 1) % slashList.length)
          return
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIdx(i => (i - 1 + slashList.length) % slashList.length)
          return
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          onPickSlash(slashList[slashIdx]!)
          return
        }
      }
      // 其他按键（字母/空格等）允许正常输入；但浮层激活期间不触发发送/翻历史
      // （回车已被上方拦截或在不匹配时落空，避免把半个 /命令 发给模型）
      if (e.key === 'Enter' && !e.shiftKey) return
    }
    // 输入法组合期间（中文拼音未上屏）的 Enter 只确认组字，不发送
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) { e.preventDefault(); handleSend() }
    else if (e.key === 'ArrowUp' && !input) { e.preventDefault(); recallHistory(-1) }
    else if (e.key === 'ArrowDown' && !input) { e.preventDefault(); recallHistory(1) }
  }

  // 始终持有最新 atQuery，供异步加载回调读取（避免闭包陈旧）
  const atQueryRef = useRef<string>('')
  useEffect(() => { atQueryRef.current = atQuery ?? '' }, [atQuery])

  // 输入框 onChange：更新文本 + 内联胶囊 + 自动增高，并检测 @ 触发文件补全浮层
  const handleInputChange = useCallback((v: RichValue) => {
    const value = v.text
    const caret = editorRef.current?.getCaretOffset() ?? value.length
    setInput(value)
    setChips(v.chips)
    autoResize()
    // 输入法组合期间不会走到这里：编辑器在组字阶段不 emit，上屏时才回调一次。
    // （原来按 isComposing 早退，是因为 textarea 的 onChange 在组字中途也会触发。）
    const dir = workspaceDir
    if (detectSlash(value, caret)) {
      // /命令 补全优先；此时不触发 @ 文件补全
      return
    }
    if (!dir) { setAtQuery(null); return }
    if (detectAt(value, caret)) {
      // 先确保文件列表已加载（按工作区缓存），再过滤
      ensureWorkspaceFiles(dir).finally(() => {
        // 输入框可能在加载期间又变化，仅当仍处于激活状态才过滤
        if (atAnchorRef.current != null) filterAtFiles(atQueryRef.current ?? '')
      })
    }
  }, [autoResize, detectAt, detectSlash, ensureWorkspaceFiles, filterAtFiles, workspaceDir])

  return { handleKeyDown, handleInputChange }
}
