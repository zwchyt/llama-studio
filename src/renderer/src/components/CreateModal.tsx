import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import { FolderOpen, ChevronDown, Terminal, Globe, Server } from 'lucide-react'
import CmdParamsEditor from './CmdParamsEditor'
import type { Template, TemplateArgs, CommandParam } from '../../../shared/types'

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
export default function CreateModal() {
  const editingTemplate = useStore(s => s.editingTemplate)
  const { setShowCreateModal, backends, activeBackend, addCard, updateCard, models, commandsSchema } = useStore(
    s => ({ setShowCreateModal: s.setShowCreateModal, backends: s.backends, activeBackend: s.activeBackend, addCard: s.addCard, updateCard: s.updateCard, models: s.models, commandsSchema: s.commandsSchema }),
    shallow
  )
  // Initialize form fields directly from editingTemplate — no useEffect needed.
  // Component always mounts fresh via {showCreateModal && <CreateModal />},
  // so initial values are always correct.
  const [name, setName] = useState(editingTemplate?.name ?? '')
  const [description, setDescription] = useState(editingTemplate?.description ?? '')
  const [backendVersion, setBackendVersion] = useState(editingTemplate?.backendVersion ?? activeBackend?.name ?? '')
  const [modelPath, setModelPath] = useState(editingTemplate?.modelPath ?? '')
  const [serverPort, setServerPort] = useState(editingTemplate?.serverPort ?? 8080)
  const [args, setArgs] = useState<TemplateArgs>(editingTemplate?.args ?? {})
  const [launchMode, setLaunchMode] = useState<'chat' | 'api'>(editingTemplate?.launchMode ?? 'chat')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importCmd, setImportCmd] = useState('')
  async function handlePickModel() {
    const file = await window.api.pickModelFile()
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
    setArgs((prev) => ({ ...prev, ...parsed.args }))
    setShowImport(false)
    setImportCmd('')
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return notify('名称为必填项', 'error')
    const templateData: Partial<Template> = {
      name,
      description,
      backendVersion,
      modelPath,
      serverPort,
      args,
      launchMode
    }
    if (editingTemplate) {
      const updated = { ...editingTemplate, ...templateData, updatedAt: new Date().toISOString() }
      const res = await window.api.saveTemplate(updated)
      if (res.success) {
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      const res = await window.api.saveTemplate(newTemplate)
      if (res.success) {
        addCard({ ...newTemplate, id: res.id } as Template)
        setShowCreateModal(false)
      }
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
            {}
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
            {}
            <div className="form-group">
              <label className="form-label">模板名称</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="例如：Llama 3 8B 默认"
                required
                autoFocus
              />
            </div>
            {}
            <div className="form-group">
              <label className="form-label">描述（可选）</label>
              <textarea
                className="form-textarea"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="此配置的简短描述..."
              />
            </div>
            {}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">后端版本</label>
                <select
                  className="form-select"
                  value={backendVersion}
                  onChange={e => setBackendVersion(e.target.value)}
                  aria-label="后端版本"
                >
                  <option value="">默认（当前）</option>
                  {backends.map(b => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">服务器端口</label>
                <input
                  type="number"
                  className="form-input"
                  value={serverPort}
                  onChange={e => setServerPort(Number(e.target.value))}
                  min={1024}
                  max={65535}
                  aria-label="服务器端口"
                />
              </div>
            </div>
            {}
            <div className="form-group">
              <label className="form-label">启动模式</label>
              <div className="launch-mode-row">
                <button type="button" className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`} onClick={() => setLaunchMode('chat')}>
                  <Globe size={13} /> 聊天界面
                </button>
                <button type="button" className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`} onClick={() => setLaunchMode('api')}>
                  <Server size={13} /> 仅 API
                </button>
              </div>
              <div className="form-hint">聊天界面会打开浏览器。仅 API 模式仅在端口提供服务，不打开网页界面。</div>
            </div>
            {}
            <div className="form-group mb-0">
              <label className="form-label">模型文件</label>
              <div className="file-picker">
                <select
                  className="form-select mono text-sm flex-1"
                  value={modelPath}
                  onChange={e => {
                    const path = e.target.value
                    setModelPath(path)
                    if (path) {
                      const filename = path.split(/[/\\]/).pop() || ''
                      const stripped = filename.replace(/\.(gguf|ggml|bin)$/i, '')
                      if (stripped) setName(stripped)
                    }
                  }}
                  aria-label="模型文件"
                >
                  <option value="">-- 选择模型 --</option>
                  {models.map(m => (
                    <option key={m.path} value={m.path}>{m.name}</option>
                  ))}
                  {modelPath && !models.find(m => m.path === modelPath) && (
                    <option value={modelPath}>{modelPath.split(/[/\\]/).pop()}</option>
                  )}
                </select>
                <button type="button" className="btn btn-secondary" onClick={handlePickModel}>
                  <FolderOpen size={16} />
                  浏览
                </button>
              </div>
              <div className="form-hint">从 /models 选择文件或浏览电脑。</div>
            </div>
            {}
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
                    onChange={setArgs}
                    modelPathFallback={modelPath}
                    serverPortFallback={serverPort}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              {editingTemplate ? '保存更改' : '创建模板'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
