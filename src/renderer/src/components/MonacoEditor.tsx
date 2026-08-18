import React, { useEffect, useRef } from 'react'
import { useThemeStore } from '../store/themeStore'
// monaco-editor 全量入口（esm/vs/index.js）会注册语言服务（tsMode/jsonMode 等），
// 这些模块在 import 时即创建 Web Worker；electron-vite 5 不支持 vite 的 ?worker 打包，
// 且 CSP 拦截 blob worker。因此改用 editor.api.js（editor 核心，无语言服务）+ 按需注册
// 内置语言 tokenizer（languages/definitions/*/register.js 为懒加载、纯主线程）。
// 限制：无智能补全/诊断（需要 worker 的语言服务），语法高亮与编辑完全可用。
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/scss/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/powershell/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/php/register.js'
import 'monaco-editor/languages/definitions/lua/register.js'
import 'monaco-editor/languages/definitions/kotlin/register.js'
import 'monaco-editor/languages/definitions/swift/register.js'
import 'monaco-editor/languages/definitions/dart/register.js'
import 'monaco-editor/languages/definitions/r/register.js'
import 'monaco-editor/languages/definitions/ruby/register.js'
import 'monaco-editor/languages/definitions/python/register.js'

// 0.56 的 languages/definitions 已无 json 目录（JSON 高亮随语言服务走 worker），
// 这里用 Monarch 手动注册一个简易 JSON tokenizer（主线程）。
monaco.languages.register({ id: 'json' })
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[,:]/, 'delimiter'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/\b(true|false)\b/, 'keyword'],
      [/\bnull\b/, 'keyword'],
    ],
  },
})

const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', svg: 'xml', vue: 'html', php: 'php', lua: 'lua',
  kt: 'kotlin', swift: 'swift', dart: 'dart', r: 'r',
}

export function extToMonacoLang(path: string): string | undefined {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase()
  return EXT_LANG[ext]
}

interface MonacoEditorProps {
  value: string
  language?: string
  readOnly?: boolean
  highlightLine?: number | null
  onSelectionAction?: (text: string, startLine: number, endLine: number) => void
  onChange?: (value: string) => void
  onSave?: (value: string) => void
}

export default function MonacoEditor({ value, language, readOnly, highlightLine, onSelectionAction, onChange, onSave }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])
  const selectionActionRef = useRef(onSelectionAction)
  const saveRef = useRef(onSave)
  const readOnlyRef = useRef(readOnly)
  const onChangeRef = useRef(onChange)
  selectionActionRef.current = onSelectionAction
  saveRef.current = onSave
  readOnlyRef.current = readOnly
  onChangeRef.current = onChange

  // 跟随应用主题：dark → vs-dark（黑布），light → vs（白布）。
  // 主题切换在 monitor 变化时立即执行（在 View Transitions 快照捕获之前完成），
  // 使 monaco 区域以新主题参与水波揭示动画，与界面其余部分同步变化、不分两段。
  const isDark = useThemeStore(s => s.theme === 'dark')
  const editorTheme = isDark ? 'vs-dark' : 'vs'

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
      readOnly: readOnlyRef.current,
      theme: editorTheme,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 18,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: 'line',
      wordWrap: 'off',
      tabSize: 2,
      padding: { top: 6 },
      contextmenu: true,
    })
    editorRef.current = editor

    editor.addAction({
      id: 'agent-reference-code',
      label: '引用代码到对话',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: (ed) => {
        const sel = ed.getSelection()
        if (!sel || sel.isEmpty()) return
        const text = ed.getModel()?.getValueInRange(sel) ?? ''
        if (text.trim()) selectionActionRef.current?.(text, sel.startLineNumber, sel.endLineNumber)
      },
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (readOnlyRef.current) return
      const model = editor.getModel()
      if (model) saveRef.current?.(model.getValue())
    })

    editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    if (model.getValue() !== value) model.setValue(value)
    if (language && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }, [value, language])

  // 主题切换时更新 monaco 主题。View Transitions 的旧快照在渲染帧 style/layout 之前捕获，
  // rAF 回调先于快照运行、useEffect/useLayoutEffect 时序不可靠，因此用双重 rAF 把
  // setTheme 推迟到快照捕获之后：快照保留旧主题画面（水波扫过时随波翻转），
  // 动画播放期间 monaco 真实 DOM 完成切换，动画结束无跳变、与界面同步。
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => monaco.editor.setTheme(editorTheme))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [editorTheme])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ readOnly: readOnly ?? false })
  }, [readOnly])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    if (!highlightLine) {
      if (decorationsRef.current.length) decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [])
      return
    }
    const cls = readOnly ? 'monaco-hl-line' : 'monaco-hl-line-edit'
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [{
      range: new monaco.Range(highlightLine, 1, highlightLine, model.getLineMaxColumn(highlightLine)),
      options: { isWholeLine: true, className: cls },
    }])
    editor.revealLineInCenterIfOutsideViewport(highlightLine)
  }, [highlightLine, readOnly])

  // 鼠标滑动（拖选）松手后引用选中代码（左键；右键有独立上下文菜单入口）。
  // 事件冒泡自 monaco 内部，selectionActionRef 保证读取最新回调。
  const handleContainerMouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const editor = editorRef.current
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!editor || !model || !sel || sel.isEmpty()) return
    const text = model.getValueInRange(sel)
    if (text.trim()) selectionActionRef.current?.(text, sel.startLineNumber, sel.endLineNumber)
  }

  return <div ref={containerRef} className="agent-code-preview-monaco" style={{ width: '100%', height: '100%' }} onMouseUp={handleContainerMouseUp} />
}
