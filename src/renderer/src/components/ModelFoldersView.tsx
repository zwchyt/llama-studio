import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { FolderPlus, Folder, ImageDown, Volume2, ScanText, Boxes, Trash } from 'lucide-react'
import { safeCall } from '../utils/safeCall'
import '../styles/settings.css'

/**
 * 模型文件夹视图：统一管理文本 / 图片 / 语音 / OCR / stable-diffusion.cpp 五类模型文件夹。
 * 从原「设置」页拆出，减少设置页内容堆叠。
 */
export default function ModelFoldersView() {
  const { setModels, setImageModels } = useStore(
    s => ({ setModels: s.setModels, setImageModels: s.setImageModels }),
    (a, b) => a.setModels === b.setModels && a.setImageModels === b.setImageModels
  )
  const [extFolders, setExtFolders] = useState<string[]>([])
  const [imgFolders, setImgFolders] = useState<string[]>([])
  const [ttsFolders, setTtsFolders] = useState<string[]>([])
  const [ocrFolders, setOcrFolders] = useState<string[]>([])
  const [sdFolders, setSdFolders] = useState<{ model: string[]; vae: string[]; llm: string[] }>({ model: [], vae: [], llm: [] })

  useEffect(() => {
    window.api.listExternalModelFolders().then(setExtFolders).catch((e) => console.error('[listExternalModelFolders]', e))
    window.api.listImageModelFolders().then(setImgFolders).catch((e) => console.error('[listImageModelFolders]', e))
    window.api.listTtsModelFolders().then(setTtsFolders).catch((e) => console.error('[listTtsModelFolders]', e))
    window.api.listOcrModelFolders().then(setOcrFolders).catch((e) => console.error('[listOcrModelFolders]', e))
    window.api.listSdModelFolders().then(setSdFolders).catch((e) => console.error('[listSdModelFolders]', e))
  }, [])

  async function refreshModels() {
    const m = await safeCall(() => window.api.listModelsRefresh(), '刷新模型列表失败')
    if (m) setModels(m)
  }
  async function refreshImageModels() {
    const m = await safeCall(() => window.api.listImageModelsRefresh(), '刷新图片模型列表失败')
    if (m) setImageModels(m)
  }

  async function handleAddExtFolder() {
    const res = await safeCall(() => window.api.addExternalModelFolder(), '添加外部文件夹失败')
    if (res && res.success && res.folders) { setExtFolders(res.folders); await refreshModels() }
  }
  async function handleRemoveExtFolder(folder: string) {
    const res = await safeCall(() => window.api.removeExternalModelFolder(folder), '移除外部文件夹失败')
    if (res && res.folders) {
      setExtFolders(res.folders)
      await refreshModels()
    }
  }

  async function handleAddImgFolder() {
    const res = await safeCall(() => window.api.addImageModelFolder(), '添加图片模型文件夹失败')
    if (res && res.success && res.folders) { setImgFolders(res.folders); await refreshImageModels() }
  }
  async function handleRemoveImgFolder(folder: string) {
    const res = await safeCall(() => window.api.removeImageModelFolder(folder), '移除图片模型文件夹失败')
    if (res && res.folders) {
      setImgFolders(res.folders)
      await refreshImageModels()
    }
  }

  async function handleAddTtsFolder() {
    const res = await safeCall(() => window.api.addTtsModelFolder(), '添加语音合成模型文件夹失败')
    if (res && res.success && res.folders) { setTtsFolders(res.folders); await refreshModels() }
  }
  async function handleRemoveTtsFolder(folder: string) {
    const res = await safeCall(() => window.api.removeTtsModelFolder(folder), '移除语音合成模型文件夹失败')
    if (res && res.folders) {
      setTtsFolders(res.folders)
      await refreshModels()
    }
  }

  async function handleAddOcrFolder() {
    const res = await safeCall(() => window.api.addOcrModelFolder(), '添加 OCR 模型文件夹失败')
    if (res && res.success && res.folders) { setOcrFolders(res.folders); await refreshModels() }
  }
  async function handleRemoveOcrFolder(folder: string) {
    const res = await safeCall(() => window.api.removeOcrModelFolder(folder), '移除 OCR 模型文件夹失败')
    if (res && res.folders) {
      setOcrFolders(res.folders)
      await refreshModels()
    }
  }

  async function handleAddSdFolder(kind: 'model' | 'vae' | 'llm') {
    const res = await safeCall(() => window.api.addSdModelFolder(kind), '添加文件夹失败')
    if (res && res.success && res.folders) {
      setSdFolders(prev => ({ ...prev, [kind]: res.folders as string[] }))
      await refreshModels()
    }
  }
  async function handleRemoveSdFolder(kind: 'model' | 'vae' | 'llm', folder: string) {
    const res = await safeCall(() => window.api.removeSdModelFolder(kind, folder), '移除文件夹失败')
    if (res && res.folders) {
      setSdFolders(prev => ({ ...prev, [kind]: res.folders as string[] }))
      await refreshModels()
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">模型文件夹</h1>
          <p className="page-subtitle">管理各类型模型文件的扫描目录</p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><Folder /> 文本模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加应用默认模型目录之外的文件夹。其中的文件（及子目录）将与已下载的模型一起显示在模型页面。文件保留在原位置——不会被复制。
          </p>
          {extFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置外部文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {extFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveExtFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddExtFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><ImageDown /> 图片模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加存放多模态投影仪文件（如 mmproj*.gguf）的文件夹。这些文件将作为图片模型出现在模板的 --mmproj 参数下拉中。
          </p>
          {imgFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置图片模型文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {imgFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveImgFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddImgFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><Volume2 /> 语音合成模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加存放语音合成模型（OuteTTS 与 WavTokenizer 声码器的 GGUF 文件）的文件夹。其中的模型将出现在语音合成视图的模型下拉中。文件保留在原位置——不会被复制。
          </p>
          {ttsFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置语音合成模型文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {ttsFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveTtsFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddTtsFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><ScanText /> OCR 模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            添加存放 OCR / 图片理解模型（如 llava、qwen2-vl 等多模态 GGUF）的文件夹。其中的模型将出现在模型页面，并可用于 OCR 文字识别与图片描述。文件保留在原位置——不会被复制。
          </p>
          {ocrFolders.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置 OCR 模型文件夹。</div>
          ) : (
            <div className="flex flex-col gap-2" style={{ width: '100%' }}>
              {ocrFolders.map(f => (
                <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '6px 0' }}>
                  <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                  <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveOcrFolder(f)}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleAddOcrFolder}>
            <FolderPlus size={13} /> 添加文件夹
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><Boxes /> stable-diffusion.cpp 模型文件夹</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            图像生成需要三类组件（如 Z-Image = 扩散模型 + VAE + Qwen3-4B 文本编码器），
            三类文件夹在此统一管理、一起添加。扫描结果会出现在模型页面，扩散模型可直接选为模板模型，
            VAE 与 LLM 文本编码器会在模板高级参数的 <code>--vae</code> / <code>--llm</code> 下拉中列出。
            文件保留在原位置——不会被复制。
          </p>
          {([
            { kind: 'model' as const, label: '扩散模型（Diffusion Model）', hint: '如 z-image-turbo-Q4_K_M.gguf' },
            { kind: 'vae' as const, label: 'VAE', hint: '如 ae.safetensors' },
            { kind: 'llm' as const, label: 'LLM 文本编码器', hint: '如 Qwen3-4B-Instruct-2507-Q4_K_M.gguf' }
          ]).map(({ kind, label, hint }) => (
            <div key={kind} className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 8, width: '100%' }}>
              <div className="settings-row-label" style={{ fontSize: 13 }}>{label}</div>
              <div className="text-sm" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{hint}</div>
              {sdFolders[kind].length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>未配置{label}文件夹。</div>
              ) : (
                <div className="flex flex-col gap-1" style={{ width: '100%' }}>
                  {sdFolders[kind].map(f => (
                    <div key={f} className="settings-row" style={{ borderBottom: 'none', padding: '4px 0' }}>
                      <div className="settings-row-sub mono" style={{ flex: 1, wordBreak: 'break-all' }}>{f}</div>
                      <button className="btn btn-ghost btn-icon text-danger" onClick={() => handleRemoveSdFolder(kind, f)}>
                        <Trash size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => handleAddSdFolder(kind)}>
                <FolderPlus size={13} /> 添加文件夹
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
