import React, { useMemo, useRef, useState } from 'react'
import { JSONUIProvider, Renderer } from '@json-render/react'
import { registry } from '../jsonui/registry'
import { makeDefaultHandlers } from '../jsonui/defaultHandlers'
import MetricsBridge from '../jsonui/MetricsBridge'
import { generateUiSpec } from '../jsonui/specGen'
import { notify } from '../store/notificationStore'
import { useStore } from '../store/useStore'
import type { Spec } from '@json-render/core'

const JSONUI_SPEC_KEY = 'jsonui.spec'
const JSONUI_UI_KEY = 'jsonui.ui-state'
const defaultHandlers = makeDefaultHandlers()

function loadPersistedSpec(): { spec: Spec | null; raw: string | null } {
  try {
    const raw = localStorage.getItem(JSONUI_SPEC_KEY)
    if (!raw) return { spec: null, raw: null }
    return { spec: JSON.parse(raw) as Spec, raw }
  } catch {
    return { spec: null, raw: null }
  }
}

function savePersistedSpec(raw: string | null) {
  try {
    if (raw) localStorage.setItem(JSONUI_SPEC_KEY, raw)
    else localStorage.removeItem(JSONUI_SPEC_KEY)
  } catch { /* storage 不可用 */ }
}

function loadPersistedUi(): { prompt: string; modelId: string } {
  try {
    const raw = localStorage.getItem(JSONUI_UI_KEY)
    if (!raw) return { prompt: '', modelId: '' }
    const parsed = JSON.parse(raw) as { prompt?: string; modelId?: string }
    return { prompt: parsed.prompt || '', modelId: parsed.modelId || '' }
  } catch {
    return { prompt: '', modelId: '' }
  }
}

function savePersistedUi(prompt: string, modelId: string) {
  try {
    localStorage.setItem(JSONUI_UI_KEY, JSON.stringify({ prompt, modelId }))
  } catch { /* storage 不可用 */ }
}

export default function JsonUiView() {
  const cards = useStore((s) => s.cards)
  const [persisted] = useState(loadPersistedSpec)
  const [persistedUi] = useState(loadPersistedUi)
  const [spec, setSpec] = useState<Spec | null>(persisted.spec)
  const [rawSpec, setRawSpec] = useState<string | null>(persisted.raw)
  const [prompt, setPrompt] = useState(persistedUi.prompt)
  const [modelId, setModelId] = useState(persistedUi.modelId)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [streamText, setStreamText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const rafPending = useRef('')
  const rafScheduled = useRef(false)

  const scheduleStreamText = (t: string) => {
    rafPending.current = t
    if (!rafScheduled.current) {
      rafScheduled.current = true
      requestAnimationFrame(() => {
        rafScheduled.current = false
        setStreamText(rafPending.current)
      })
    }
  }

  const formattedJson = useMemo(
    () => (rawSpec ? JSON.stringify(JSON.parse(rawSpec), null, 2) : ''),
    [rawSpec]
  )

  const runningModels = useMemo(
    () => cards.filter((c) => c.status === 'running')
      .map((c) => ({ id: c.template.id, name: c.template.name, port: c.template.serverPort || 8080 })),
    [cards]
  )

  const activePort = runningModels.find((m) => m.id === modelId)?.port

  const handleGenerate = async () => {
    if (!prompt.trim() || !activePort || generating) return
    const controller = new AbortController()
    abortRef.current = controller
    setGenerating(true)
    setGenError(null)
    setStreamText('')
    savePersistedUi(prompt.trim(), modelId)
    try {
      const { spec: generated, raw } = await generateUiSpec(prompt.trim(), activePort, {
        onDelta: scheduleStreamText,
        signal: controller.signal,
      })
      setSpec(generated)
      setRawSpec(raw)
      setStreamText('')
      savePersistedSpec(raw)
      notify('界面已由模型生成')
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        notify('已取消生成')
        return
      }
      const msg = e?.message || String(e)
      setGenError(msg)
      notify(`生成失败：${msg}`, 'error')
    } finally {
      abortRef.current = null
      setGenerating(false)
    }
  }

  return (
    <div className="view jsonui">
      <div className="jui-view">
        <div className="jui-view-header">
          <span className="jui-view-title">
            json-render 动态 UI · 模型生成
          </span>
          <span className="jui-view-hint">状态绑定 / 事件绑定 / 白名单 action</span>
        </div>

        <div className="jui-gen">
          <textarea
            className="jui-gen-input"
            placeholder="描述你想要生成的界面，例如：画一张显存不足的诊断卡片，含原因、修复建议和一个任务时间线；或：模型下载进度的卡片"
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); savePersistedUi(e.target.value, modelId) }}
            rows={3}
          />
          <div className="jui-gen-row">
            <select
              className="jui-gen-model"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); savePersistedUi(prompt, e.target.value) }}
              disabled={runningModels.length === 0}
            >
              <option value="">{runningModels.length === 0 ? '暂无运行中的模型' : '选择运行中的模型'}</option>
              {runningModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name} (:${m.port})</option>
              ))}
            </select>
            <button
              className="jui-btn"
              onClick={handleGenerate}
              disabled={!prompt.trim() || !activePort || generating}
            >
              让模型生成界面
            </button>
            {generating && (
              <button
                className="jui-btn jui-btn-danger"
                onClick={() => abortRef.current?.abort()}
              >
                取消生成
              </button>
            )}
          </div>
          {genError && <div className="jui-gen-error">{genError}</div>}
        </div>

        <div className="jui-view-actions">
          {spec && (
            <button className="jui-btn jui-btn-ghost" onClick={() => { setSpec(null); setRawSpec(null); setStreamText(''); savePersistedSpec(null) }}>
              清空
            </button>
          )}
        </div>

        <div className="jui-main">
          <div className="jui-stage">
            <JSONUIProvider
              registry={registry}
              initialState={{}}
              handlers={defaultHandlers}
            >
              <MetricsBridge modelId={modelId} />
              {spec ? (
                <Renderer spec={spec} registry={registry} />
              ) : (
                <div className="jui-empty">
                  <div className="jui-empty-title">描述你想要的界面，由模型生成</div>
                  <div className="jui-empty-hint">
                    示例：「画一张显存不足的诊断卡片，含原因、修复建议和一个任务时间线」或「模型下载进度的卡片」
                  </div>
                </div>
              )}
            </JSONUIProvider>
          </div>

          <div className="jui-json-panel">
            <div className="jui-json-panel-header">
              <span className="jui-json-panel-title">
                {generating ? '正在生成 JSON…' : 'JSON 输出'}
              </span>
              {rawSpec && !generating && (
                <button
                  className="jui-btn jui-btn-ghost jui-json-copy"
                  onClick={() => {
                    navigator.clipboard.writeText(formattedJson).catch(() => { })
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1200)
                  }}
                >
                  {copied ? '已复制' : '复制'}
                </button>
              )}
            </div>
            <div className="jui-json-panel-body">
              {generating || streamText ? (
                <pre className="jui-json-code jui-json-stream">{streamText || '等待模型输出…'}</pre>
              ) : rawSpec ? (
                <pre className="jui-json-code">{formattedJson}</pre>
              ) : (
                <div className="jui-json-empty">生成后在此查看模型输出的 JSON</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}