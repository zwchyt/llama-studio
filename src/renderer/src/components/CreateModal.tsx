import React, { useMemo, useState } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import { paramSetOf, ENGINE_LABELS } from '../utils/engine'
import { switchParamSetArgs, syncArgsByParamSet } from '../utils/defaultTemplate'
import { FolderOpen, ChevronDown, Terminal, Globe, Server, Loader2 } from 'lucide-react'
import CmdParamsEditor from './CmdParamsEditor'
import CustomSelect from './CustomSelect'
import type { ModelFileInfo } from '../store/useStore'
import type { Template, TemplateArgs, CommandParam, EngineKind } from '../../../shared/types'

/** 各引擎的默认端口：TensorSharp 固定 5000，sd-server 默认 1234，audiocpp 默认 8088，llama.cpp 系列 8080 */
function defaultPortFor(kind: EngineKind | undefined | null): number {
  return kind === 'tensorsharp' ? 5000 : kind === 'sdcpp' ? 1234 : kind === 'audiocpp' ? 8088 : 8080
}

const EXTRA_ALIASES: Record<string, string> = {
  '-sm': '--split-mode',
  '-mg': '--main-gpu',
  '-sys': '--system-prompt',
  '-j': '--json-schema',
  '-ts': '--tensor-split',
  '-dev': '--device',
}

function buildShortFlagAliases(schema: { categories: { commands: CommandParam[] }[] } | null): Record<string, string> {
  const aliases: Record<string, string> = { ...EXTRA_ALIASES }
  if (schema) {
    for (const cat of schema.categories) {
      for (const cmd of cat.commands) {
        if (cmd.short) aliases[cmd.short] = cmd.arg
      }
    }
  }
  return aliases
}

function parseCommand(cmd: string, shortFlagAliases: Record<string, string>): {
  modelPath: string
  serverPort: number
  args: TemplateArgs
} {
  const parts: string[] = []
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(cmd)) !== null) {
    parts.push(m[0].replace(/^['"]|['"]$/g, ''))
  }
  let modelPath = ''
  let serverPort = 8080
  const args: Record<string, string | number | boolean> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === '-m' || p === '--model') {
      modelPath = parts[++i] || ''
    } else if (p === '--port') {
      serverPort = parseInt(parts[++i] || '8080', 10)
    } else if (shortFlagAliases[p]) {
      const next = parts[i + 1]
      if (next && !next.startsWith('-')) {
        const numVal = Number(next)
        args[shortFlagAliases[p]] = isNaN(numVal) ? next : numVal
        i++
      } else {
        args[shortFlagAliases[p]] = true
      }
    } else if (p.startsWith('--') || p.startsWith('-')) {
      const next = parts[i + 1]
      if (next && !next.startsWith('-')) {
        const numVal = Number(next)
        args[p] = isNaN(numVal) ? next : numVal
        i++
      } else {
        args[p] = true
      }
    }
  }
  return { modelPath, serverPort, args }
}
/** 合并两组模型并按路径去重（后一组覆盖前一组） */
function mergeModelLists(base: ModelFileInfo[], extra: ModelFileInfo[]): ModelFileInfo[] {
  const byPath = new Map<string, ModelFileInfo>()
  for (const m of base) byPath.set(m.path, m)
  for (const m of extra) byPath.set(m.path, m)
  return [...byPath.values()]
}

export default function CreateModal() {
  const editingTemplate = useStore(s => s.editingTemplate)
  const { setShowCreateModal, backends, activeBackend, setActiveBackend, addCard, updateCard, models, imageModels, commandsSchema } = useStore(
    s => ({ setShowCreateModal: s.setShowCreateModal, backends: s.backends, activeBackend: s.activeBackend, setActiveBackend: s.setActiveBackend, addCard: s.addCard, updateCard: s.updateCard, models: s.models, imageModels: s.imageModels, commandsSchema: s.commandsSchema }),
    shallow
  )
  // Initialize form fields directly from editingTemplate — no useEffect needed.
  // Component always mounts fresh via {showCreateModal && <CreateModal />},
  // so initial values are always correct.
  const [name, setName] = useState(editingTemplate?.name ?? '')
  const [description, setDescription] = useState(editingTemplate?.description ?? '')
  const initialBackend = editingTemplate?.backendVersion
    ? (backends.some(b => b.name === editingTemplate.backendVersion) ? editingTemplate.backendVersion : '')
    : (activeBackend?.name ?? '')
  const [backendVersion, setBackendVersion] = useState(initialBackend)
  const [modelPath, setModelPath] = useState(editingTemplate?.modelPath ?? '')
  // TensorSharp 固定监听 5000 端口（官方硬编码），sd-server 默认 1234，端口字段仅作展示
  const [serverPort, setServerPort] = useState(() => {
    if (editingTemplate) {
      const b = backends.find(x => x.name === editingTemplate.backendVersion)
      return b?.kind === 'tensorsharp' ? 5000 : (editingTemplate.serverPort ?? defaultPortFor(b?.kind))
    }
    const b = backends.find(x => x.name === initialBackend)
    return defaultPortFor(b?.kind)
  })
  const [paramSet, setParamSet] = useState(() => {
    if (editingTemplate?.paramSet) return paramSetOf(editingTemplate.paramSet)
    const b = backends.find(x => x.name === initialBackend)
    return paramSetOf(b?.kind)
  })
  // 各引擎独立保存的启动参数：切换引擎后回切时恢复该引擎自定义值，不丢参数
  const [argsByParamSet, setArgsByParamSet] = useState<Partial<Record<'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp', TemplateArgs>>>(() => {
    if (editingTemplate?.argsByParamSet && Object.keys(editingTemplate.argsByParamSet).length > 0) {
      return editingTemplate.argsByParamSet
    }
    // 旧模板无 argsByParamSet：以当前 args 作为当前参数集的一份快照
    return { [paramSet]: { ...(editingTemplate?.args ?? {}) } }
  })
  // 新建模板且后端为 TensorSharp / stable-diffusion.cpp 时，预填各自默认采样参数
  // （TensorSharp 无 --ctx-size/--threads 等 llama.cpp 参数；sd-server 预填生成默认值）
  const [args, setArgs] = useState<TemplateArgs>(() => {
    if (editingTemplate?.args) return editingTemplate.args
    if (argsByParamSet[paramSet] && Object.keys(argsByParamSet[paramSet]!).length > 0) return argsByParamSet[paramSet]!
    const b = backends.find(x => x.name === initialBackend)
    if (b?.kind === 'tensorsharp') {
      return { '--temperature': 0.7, '--repeat-penalty': 1.1, '--max-tokens': 20000 }
    }
    if (b?.kind === 'sdcpp') {
      return { '--steps': 20, '--cfg-scale': 7 }
    }
    return {}
  })
  // 参数编辑统一入口：同步写入 args 与 argsByParamSet[当前引擎]
  const handleArgsChange = (nextArgs: TemplateArgs) => {
    setArgs(nextArgs)
    setArgsByParamSet(prev => syncArgsByParamSet(paramSet, nextArgs, prev))
  }
// sd-server 无聊天 UI，新建 sdcpp 模板时默认 API 模式
  const [launchMode, setLaunchMode] = useState<'chat' | 'api'>(editingTemplate?.launchMode ?? (() => {
    const b = backends.find(x => x.name === initialBackend)
    return b?.kind === 'sdcpp' ? 'api' : 'chat'
  })())
  // 参数集切换：同步更新显示 + 切换活跃后端 + 端口默认值 + 后端版本下拉框
  const handleParamSetChange = (next: 'llamacpp' | 'tensorsharp' | 'turboquant' | 'beellama' | 'sdcpp' | 'audiocpp') => {
    if (next === paramSet) return
    const filename = (modelPath.split(/[/\\]/).pop() || '')
    const { args: nextArgs, argsByParamSet: nextByParamSet } = switchParamSetArgs(paramSet, args, argsByParamSet, next, filename)
    setParamSet(next)
    setArgs(nextArgs)
    setArgsByParamSet(nextByParamSet)
    const targetBackend = backends.find(b => b.kind === next)
    if (targetBackend) {
      setActiveBackend(targetBackend)
      setBackendVersion(targetBackend.name)
    }
    setServerPort(defaultPortFor(next === 'tensorsharp' || next === 'sdcpp' || next === 'audiocpp' ? next : 'llamacpp'))
  }
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importCmd, setImportCmd] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 模型文件下拉：来源就是用户在「模型文件夹」里配置的那些目录——两个扫描结果都要并进来：
  //   models      文本 / OCR / 生图（含 VAE、CLIP）等各类文件夹
  //   imageModels 「图片模型文件夹」（单独扫描，不进 models）
  // 只剔除不能当模板主模型的：VAE、CLIP（sdRole=llm）、mmproj 多模态投影，
  // 以及语音合成(TTS) / 语音转写(ASR)——这两类各有专用界面，不走模板卡片。
  // 不按引擎筛：同一批文件夹里的权重可能分属不同引擎，按引擎筛会把用户自己加进来的模型藏掉。
  const { modelOptions, modelScopeHint } = useMemo(() => {
    const pool = mergeModelLists(models, imageModels)
    const matched = pool.filter(m =>
      !m.tts && !m.asr && m.sdRole !== 'vae' && m.sdRole !== 'llm' && !/mmproj/i.test(m.name))
    if (matched.length === 0) {
      return { modelOptions: pool, modelScopeHint: '未找到可用模型，已列出全部文件。' }
    }
    const hidden = pool.length - matched.length
    return {
      modelOptions: matched,
      modelScopeHint: hidden > 0
        ? `来自你配置的模型文件夹，已隐藏 ${hidden} 个 VAE / CLIP / mmproj / 语音模型组件。`
        : '来自你配置的模型文件夹。'
    }
  }, [models, imageModels])

  async function handlePickModel() {
    const file = await safeCall(() => window.api.pickModelFile(), '选择模型文件失败')
    if (file) {
      setModelPath(file.path)
      const filename = file.path.split(/[/\\]/).pop() || ''
      const stripped = filename.replace(/\.(gguf|ggml|bin)$/i, '')
      if (stripped) setName(stripped)
    }
  }
  function handleImportCmd() {
    if (!importCmd.trim()) return
    const aliases = buildShortFlagAliases(commandsSchema)
    const parsed = parseCommand(importCmd, aliases)
    if (parsed.modelPath?.trim()) setModelPath(parsed.modelPath.trim())
    const port = Math.min(65535, Math.max(1024, parsed.serverPort || 8080))
    setServerPort(port)
    handleArgsChange({ ...args, ...parsed.args })
    setShowImport(false)
    setImportCmd('')
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (!name.trim()) return notify('名称为必填项', 'error')
    const templateData: Partial<Template> = {
      name,
      description,
      backendVersion,
      modelPath,
      serverPort,
      args,
      argsByParamSet,
      launchMode,
      paramSet
    }
    setSubmitting(true)
    try {
      if (editingTemplate) {
        const updated = { ...editingTemplate, ...templateData, updatedAt: new Date().toISOString() }
        const res = await safeCall(() => window.api.saveTemplate(updated), '保存模板失败')
        if (res && res.success) {
          updateCard(editingTemplate.id, { ...templateData, updatedAt: updated.updatedAt })
          setShowCreateModal(false)
        }
      } else {
        const newTemplate: Omit<Template, 'id'> = {
          name,
          description,
          backendVersion,
          modelPath,
          serverPort,
          args,
          launchMode,
          paramSet,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        const res = await safeCall(() => window.api.saveTemplate(newTemplate), '创建模板失败')
        if (res && res.success) {
          addCard({ ...newTemplate, id: res.id } as Template)
          setShowCreateModal(false)
        }
      }
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{editingTemplate ? '编辑模板' : '新建模板'}</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="modal-body">
            <div className="collapsible-section" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => setShowImport(!showImport)}
              >
                <Terminal size={14} />
                <span>从命令导入</span>
                <ChevronDown
                  size={14}
                  style={{ marginLeft: 'auto', transform: showImport ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
                />
              </button>
              {showImport && (
                <div className="collapsible-body">
                  <p className="form-hint" style={{ marginBottom: 8 }}>
                    粘贴 <code>llama-server</code> 命令，表单将自动填充。
                  </p>
                  <textarea
                    className="form-textarea mono"
                    rows={3}
                    value={importCmd}
                    onChange={e => setImportCmd(e.target.value)}
                    placeholder="llama-server -m /models/model.gguf --port 8080 --ctx-size 4096 ..."
                    style={{ fontSize: 12, fontFamily: "'SF Mono','Fira Code',monospace" }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={handleImportCmd}
                  >
                    解析并填充
                  </button>
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">模板名称</label>
              <input
                type="text"
                className="form-input form-input-flat"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="例如：Llama 3 8B 默认"
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">描述（可选）</label>
              <textarea
                className="form-textarea"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="此配置的简短描述..."
              />
            </div>
            <div className="form-group">
              <label className="form-label">后端版本</label>
              <CustomSelect
                buttonClass="form-select-button"
                value={backendVersion}
                onChange={(v) => {
                  setBackendVersion(v)
                  // 切换后端时参数集跟随后端类型（llama.cpp / TensorSharp / llama.cpp 分支各自专属参数文件）
                  const b = backends.find(x => x.name === v)
                  const nextPs = paramSetOf(b?.kind)
                  const fname = (modelPath.split(/[/\\]/).pop() || '')
                  const { args: nextArgs, argsByParamSet: nextByParamSet } = switchParamSetArgs(paramSet, args, argsByParamSet, nextPs, fname)
                  setParamSet(nextPs)
                  setArgs(nextArgs)
                  setArgsByParamSet(nextByParamSet)
                  setServerPort(defaultPortFor(nextPs === 'tensorsharp' || nextPs === 'sdcpp' || nextPs === 'audiocpp' ? nextPs : 'llamacpp'))
                }}
                options={[
                  { value: '', label: '默认（当前）' },
                  ...backends.map(b => ({
                    value: b.name,
                    // 带引擎前缀方便区分（目录名很长，如 tqp-v0.3.0-turboquant-plus-…）；下拉项已做省略号截断
                    label: b.kind && b.kind !== 'other' ? `[${ENGINE_LABELS[b.kind] ?? b.kind}] ${b.name}` : b.name
                  }))
                ]}
                aria-label="后端版本"
              />
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
              <div className="form-group" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}>
                <label className="form-label">启动模式</label>
                <div className="launch-mode-row">
                  <button type="button" className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`} onClick={() => setLaunchMode('chat')}>
                    <Globe size={13} /> 聊天界面
                  </button>
                  <button type="button" className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`} onClick={() => setLaunchMode('api')}>
                    <Server size={13} /> 仅 API
                  </button>
                </div>
              </div>
              <div className="form-group" style={{ width: 140, marginBottom: 0 }}>
                <label className="form-label">服务器端口</label>
                <input
                  type="number"
                  className="form-input form-input-flat"
                  value={serverPort}
                  onChange={e => setServerPort(Number(e.target.value))}
                  min={1024}
                  max={65535}
                  aria-label="服务器端口"
                  disabled={backends.find(b => b.name === backendVersion)?.kind === 'tensorsharp'}
                />
              </div>
            </div>
            <div className="form-group">
              <div className="form-hint">聊天界面会打开浏览器。仅 API 模式仅在端口提供服务，不打开网页界面。</div>
            </div>
            <div className="form-group mb-0">
              <label className="form-label">模型文件</label>
              <div className="file-picker">
                <CustomSelect
                  buttonClass="form-select-button mono text-sm"
                  style={{ flex: 1 }}
                  value={modelPath}
                  onChange={v => {
                    setModelPath(v)
                    if (v) {
                      const filename = v.split(/[/\\]/).pop() || ''
                      const stripped = filename.replace(/\.(gguf|ggml|bin|safetensors|ckpt|pth|pt)$/i, '')
                      if (stripped) setName(stripped)
                    }
                  }}
                  options={[
                    { value: '', label: '-- 选择模型 --' },
                    ...modelOptions.map(m => ({ value: m.path, label: m.name })),
                    // 当前选中的模型若不在筛选结果里（切换过引擎、或手动浏览进来的文件），
                    // 补一项，别让下拉显示为空
                    ...(modelPath && !modelOptions.find(m => m.path === modelPath)
                      ? [{ value: modelPath, label: modelPath.split(/[/\\]/).pop() || '' }]
                      : [])
                  ]}
                  aria-label="模型文件"
                />
                <button type="button" className="btn btn-secondary" onClick={handlePickModel}>
                  <FolderOpen size={16} />
                  浏览
                </button>
              </div>
              <div className="form-hint">从已配置的模型文件夹选择，或点「浏览」挑任意文件。{modelScopeHint}</div>
            </div>
            <div className="collapsible-section" style={{ marginTop: 20 }}>
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <span>高级参数</span>
                <ChevronDown
                  size={14}
                  style={{ marginLeft: 'auto', transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
                />
              </button>
              {showAdvanced && (
                <div className="collapsible-body">
                  <CmdParamsEditor
                    args={args}
                    onChange={handleArgsChange}
                    backendName={backendVersion}
                    modelPathFallback={modelPath}
                    serverPortFallback={serverPort}
                    paramSet={paramSet}
                    onParamSetChange={handleParamSetChange}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? <Loader2 size={14} className="spin" /> : null}
              {editingTemplate ? '保存更改' : '创建模板'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
