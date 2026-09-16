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
    input, setInput, packedInput, setPackedInput,
    refChips, setRefChips, codeSnippets, setCodeSnippets,
    autoResize, recallHistory,
  } = inputDomain
  const {
    atQuery, setAtQuery, atAnchorRef, slashQuery, setSlashQuery,
    slashList, slashIdx, setSlashIdx, ensureWorkspaceFiles,
    detectAt, filterAtFiles, detectSlash, onPickSlash,
  } = hintsDomain

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合输入中（中文/日文输入法选词）不触发发送，避免误发消息
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // 光标在最开头且无选区时按退格：像删文字一样从右往左删掉最后一个胶囊
    // （超长打包 chip 排最右 → 引用胶囊 → 代码片段胶囊）
    if ((e.key === 'Backspace' || e.key === 'Delete') && (packedInput !== null || refChips.length > 0 || codeSnippets.length > 0) && !input) {
      const el = e.currentTarget
      if ((el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0) {
        e.preventDefault()
        if (packedInput !== null) setPackedInput(null)
        else if (refChips.length > 0) setRefChips(prev => prev.slice(0, -1))
        else setCodeSnippets(prev => prev.slice(0, -1))
        return
      }
    }
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    else if (e.key === 'ArrowUp' && !input) { e.preventDefault(); recallHistory(-1) }
    else if (e.key === 'ArrowDown' && !input) { e.preventDefault(); recallHistory(1) }
  }

  // 始终持有最新 atQuery，供异步加载回调读取（避免闭包陈旧）
  const atQueryRef = useRef<string>('')
  useEffect(() => { atQueryRef.current = atQuery ?? '' }, [atQuery])

  // 输入框 onChange：更新文本 + 自动增高，并检测 @ 触发文件补全浮层
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const caret = e.target.selectionStart ?? value.length
    setInput(value)
    autoResize()
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
