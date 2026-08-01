// ─────────────────────────────────────────────────────────────
// Agent 浏览器 UI 注释工具（Agentation 式，页面上下文注入版）
// 由宿主在 webview/iframe 加载后通过 executeJavaScript/eval 注入（?raw 打包）。
//
// 四种注释模式：
//   元素 element — hover 高亮，点击单个元素（橙色标记）
//   区域 area    — 拖动框选任意区域（含空白），布局/占位反馈（绿色标记）
//   多选 multi   — 逐个点击元素累积，或 ⇧/⌘+拖动框选多个元素，一条注释（绿色标记）
//   文本 text    — 拖选文本标注拼写/文案（绿色标记）
// 工具栏：模式切换 / 暂停动画 / 显示隐藏标记 / 复制 Markdown / 清除 / 退出（可拖动）
// 标记：角标数字，点击移除，右键编辑。数据挂 window.__agentAnnotateData，
// 宿主轮询 snapshot() 取回。控制接口挂 window.__agentAnnotate。
// ─────────────────────────────────────────────────────────────
;(() => {
  // 防重复注入（SPA 内多次加载 / 重复执行）
  if (window.__agentAnnotate) return

  const UI_ATTR = 'data-agent-annotate-ui'
  const DEFAULT_COLOR = '#f59e0b'
  const MODE_LABEL = { element: '元素', area: '区域', multi: '多选', text: '文本' }
  const THEME_BG = 'rgba(24, 26, 31, 0.96)'
  const STORAGE_KEY = 'agentAnnotate:v1'

  // ── 设置（localStorage 持久化，7 天有效）──
  // reactMode: compact（关 React）/ standard（过滤框架组件）/ forensic（全部含框架内部）
  // color: 元素/文本标记色（区域/多选固定绿色）；clearOnCopy / blockInteractions 行为开关
  const DEFAULT_SETTINGS = {
    reactMode: 'standard',
    color: DEFAULT_COLOR,
    clearOnCopy: false,
    blockInteractions: true,
  }
  const loadSettings = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY + ':settings')
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    } catch {}
    return { ...DEFAULT_SETTINGS }
  }
  let settings = loadSettings()
  const saveSettings = () => {
    try { localStorage.setItem(STORAGE_KEY + ':settings', JSON.stringify(settings)) } catch {}
  }
  // 标记色：区域/多选固定绿（Agentation 规则），元素/文本用设置色
  const colorFor = (kind) => (kind === 'area' || kind === 'multi') ? '#22c55e' : settings.color

  let active = false
  let mode = null             // element | area | multi | text | inspect（null = 无模式）
  let hoverEl = null
  let pinnedEl = null
  let panelOpen = false
  let annotations = []
  let markersVisible = true   // 角标显示/隐藏（H 快捷键切换）
  let animPaused = false
  let multiSel = []            // 多选模式累积的元素（暂存，未成注释）
  let drag = null              // { x0, y0, x1, y1, kind: 'area' | 'multi-drag' }
  let editingId = null         // 编辑已有注释时非 null

  // ── 工具函数 ──
  const isUI = (t) => !!(t && ((t.getAttribute && t.getAttribute(UI_ATTR) !== null) || (t.closest && t.closest(`[${UI_ATTR}]`))))

  const $ = (tag, style, attrs = {}) => {
    const el = document.createElement(tag)
    Object.assign(el.style, style)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.setAttribute(UI_ATTR, '')
    return el
  }

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return ''
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node.tagName !== 'HTML' && node.tagName !== 'BODY') {
      if (node.hasAttribute(UI_ATTR)) break
      let sel = node.tagName.toLowerCase()
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break }
      const cls = [...node.classList].filter(c => c.length > 2 && !/^(active|selected|hover|focus|open|visible)$/i.test(c) && !c.startsWith('_')).slice(0, 2)
      if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.')
      const parent = node.parentElement
      if (parent) {
        const sibs = [...parent.children].filter(s => s.tagName === node.tagName)
        if (sibs.length > 1) sel += `:nth-child(${[...parent.children].indexOf(node) + 1})`
      }
      parts.unshift(sel)
      node = parent
    }
    return parts.join(' > ')
  }

  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'color', 'background-color',
    'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border-radius',
    'text-align', 'align-items', 'justify-content', 'flex-direction', 'gap', 'z-index', 'overflow', 'transform']

  const computedInfo = (el) => {
    const cs = getComputedStyle(el)
    const out = {}
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k)
      if (v && v !== 'none' && v !== 'normal' && v !== '0px') out[k] = v
    }
    const rect = el.getBoundingClientRect()
    return { ...out, w: Math.round(rect.width) + 'px', h: Math.round(rect.height) + 'px' }
  }

  // React 组件链（按设置档位：compact 关闭 / standard 过滤框架组件 / forensic 全部含框架内部）
  const reactChain = (el) => {
    if (settings.reactMode === 'compact') return ''
    try {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
      if (!fiberKey) return ''
      const names = []
      let inst = el[fiberKey]
      let n = 0
      while (inst && n++ < 14) {
        const t = inst.type
        if (typeof t === 'string' && t === el.tagName.toLowerCase()) { inst = inst.return; continue }
        const name = typeof t === 'string' ? null : (t?.displayName || t?.name || (t?.render && (t.render.name || 'Anonymous')))
        if (name) {
          // standard 档：跳过框架内部组件（forwardRef/memo/Provider/Context 等）
          if (settings.reactMode === 'standard' && /^(forwardRef|memo|Fragment|Suspense|ErrorBoundary|Provider|Consumer|Context|$)$/.test(name)) { inst = inst.return; continue }
          if (!names.includes(name)) names.unshift(name)
        }
        inst = inst.return
      }
      return names.slice(-8).join(' → ')
    } catch { return '' }
  }

  const textSummary = (el, max = 60) => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return t ? (t.length > max ? t.slice(0, max) + '…' : t) : ''
  }

  const elemInfo = (el) => {
    let name = (el.id ? '#' + el.id : '') + (el.getAttribute('aria-label') ? ` [${el.getAttribute('aria-label')}]` : '')
    // 智能命名（Agentation 式）：按钮/链接/输入/图片以文本内容命名，便于 Agent grep
    const tag = el.tagName.toLowerCase()
    if (!name && (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'img' || tag === 'label' || tag === 'textarea')) {
      const t = (el.innerText || el.value || el.getAttribute('alt') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 30)
      if (t) name = ` "${t}"`
    }
    return {
      selector: cssPath(el),
      tag,
      name,
      summary: textSummary(el),
    }
  }

  const newId = () => 'ann-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  // ── 数据同步 ──
  const sync = () => {
    try {
      window.__agentAnnotateData = { active, annotations: annotations.slice() }
      // 本地持久化（按页存储，7 天内刷新/重开保留；空则清除）
      const key = STORAGE_KEY + ':' + location.host + location.pathname
      if (annotations.length) localStorage.setItem(key, JSON.stringify({ ts: Date.now(), annotations }))
      else localStorage.removeItem(key)
      // iframe 嵌入（HTML 预览同源）：事件驱动 postMessage 推送给宿主，免轮询开销；
      // webview 顶层页面（window.parent === window）不推送，宿主走轮询
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'agent-annotate', data: { active, annotations: annotations.slice() } }, '*')
      }
    } catch {}
  }

  // ── Markdown 构建（页面内复制用，与宿主 formatAnnotations 同构）──
  const buildMarkdown = () => {
    const head = annotations.length > 0 ? annotations[0].url || '' : ''
    const lines = [
      '# 页面 UI 反馈注释',
      `页面: ${head}`,
      `数量: ${annotations.length} 条`,
      '',
      ...annotations.map((a, i) => {
        const style = Object.entries(a.styles || {}).map(([k, v]) => `${k}: ${v}`).join('; ')
        const lines2 = [`## ${i + 1}. ${a.note}`]
        if (a.kind === 'area' && a.rect) {
          lines2.push('- 类型: 区域')
          lines2.push(`- 区域: ${Math.round(a.rect.w)}×${Math.round(a.rect.h)} @ (${Math.round(a.rect.x)}, ${Math.round(a.rect.y)})（视口坐标）`)
          if (a.elements.length) lines2.push(`- 覆盖元素: ${a.elements.map(e => '`' + e.selector + '`').join(' / ')}`)
        } else if (a.kind === 'multi') {
          lines2.push(`- 类型: 多选（${a.elements.length} 个元素）`)
          a.elements.forEach(e => lines2.push(`- 选择器: \`${e.selector}\`（<${e.tag}${e.name ? ' ' + e.name : ''}>${e.summary ? ' "' + e.summary + '"' : ''}）`))
          if (style) lines2.push(`- 计算样式: ${style}`)
        } else if (a.kind === 'text') {
          lines2.push('- 类型: 文本')
          if (a.text) lines2.push(`- 引用文本: "${a.text}"`)
          const e = a.elements[0]
          if (e) lines2.push(`- 元素: \`${e.selector}\`（<${e.tag}>）`)
        } else {
          const e = a.elements[0] || {}
          lines2.push(`- 选择器: \`${e.selector || ''}\``)
          lines2.push(`- 元素: <${e.tag || ''}${e.name ? ' ' + e.name : ''}>`)
          if (e.summary) lines2.push(`- 文本: "${e.summary}"`)
          if (a.component) lines2.push(`- React 组件链: ${a.component}`)
          if (style) lines2.push(`- 计算样式: ${style}`)
        }
        return lines2.filter(Boolean).join('\n')
      }),
    ]
    return lines.join('\n')
  }

  const copyToClipboard = () => {
    const md = buildMarkdown()
    const done = () => {
      toast('已复制 Markdown（' + annotations.length + ' 条注释）')
      // 设置「复制后清除」：复制成功即清空注释
      if (settings.clearOnCopy) { annotations = []; renderMarkers(); sync() }
    }
    const fail = () => toast('复制失败：请使用「发送给 Agent」')
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(md).then(done).catch(() => fallbackCopy(md) ? done() : fail())
      } else {
        fallbackCopy(md) ? done() : fail()
      }
    } catch { fallbackCopy(md) ? done() : fail() }
  }
  const fallbackCopy = (text) => {
    try {
      const ta = $('textarea', { position: 'fixed', left: '-9999px', top: '0' })
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }

  // ── 提示 toast ──
  let toastTimer = null
  const toast = (msg) => {
    if (!toastEl) return
    toastEl.textContent = msg
    toastEl.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.style.display = 'none' }, 1800)
  }

  // ── UI 元素 ──
  const tooltip = $('div', {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    background: THEME_BG, color: '#e5e7eb', font: '11px/1.5 system-ui, sans-serif',
    padding: '5px 9px', borderRadius: '6px', maxWidth: '380px', display: 'none',
    boxShadow: '0 2px 10px rgba(0,0,0,.35)',
  })
  const toastEl = $('div', {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    left: '50%', bottom: '64px', transform: 'translateX(-50%)',
    background: THEME_BG, color: '#e5e7eb', font: '11px system-ui, sans-serif',
    padding: '5px 12px', borderRadius: '6px', display: 'none',
  })

  // 工具栏（可拖动）
  const toolbar = $('div', {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    background: THEME_BG, border: '1px solid rgba(255,255,255,.16)', borderRadius: '10px',
    font: '11px/1 system-ui, sans-serif', color: '#e5e7eb', display: 'none',
    boxShadow: '0 4px 20px rgba(0,0,0,.4)', userSelect: 'none', flexDirection: 'column',
  })
  const tbHead = $('div', {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px 4px',
    borderBottom: '1px solid rgba(255,255,255,.08)', cursor: 'move', whiteSpace: 'nowrap',
  })
  tbHead.innerHTML = '<span style="font-weight:600;font-size:10.5px;letter-spacing:.5px">UI 注释</span>'
  const tbExit = $('button', {
    border: 'none', background: 'transparent', color: '#9ca3af', cursor: 'pointer',
    font: '13px/1 system-ui', padding: '0 2px', marginLeft: '4px',
  }, { title: '退出注释模式' })
  tbExit.textContent = '✕'
  tbHead.appendChild(tbExit)
  const tbBody = $('div', { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 10px 8px', flexWrap: 'wrap' })

  // 模式按钮组（全部按钮共用一个高亮池：任何时刻只有一个按钮实底高亮）
  const ALL_BTNS = []
  const setBtnVisual = (b, on) => {
    b.style.background = on ? '#f59e0b' : 'transparent'
    b.style.color = on ? '#1a1a1a' : '#cbd5e1'
    b.style.borderColor = on ? '#f59e0b' : 'rgba(255,255,255,.14)'
  }
  const clearAllActive = () => ALL_BTNS.forEach(b => setBtnVisual(b, false))
  const selectOnly = (b) => { clearAllActive(); setBtnVisual(b, true) }

  const modeBtn = (key) => {
    const b = $('button', {
      border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#cbd5e1',
      font: '11px system-ui, sans-serif', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer',
    }, { title: `${MODE_LABEL[key]}模式` })
    b.textContent = MODE_LABEL[key]
    ALL_BTNS.push(b)
    b.onclick = (e) => {
      e.stopPropagation()
      // 再点当前激活的模式 = 取消模式：全部按钮熄灭，注释工具不再响应点击
      if (mode === key) {
        mode = null
        clearHover(); clearPin(); clearMulti(); closePanel()
        drag = null; dragBox.style.display = 'none'
        clearAllActive()
        return
      }
      selectOnly(b)
      setMode(key)
    }
    return b
  }
  const tbMode = { element: modeBtn('element'), area: modeBtn('area'), multi: modeBtn('multi'), text: modeBtn('text') }

  // 工具按钮（同样加入单选高亮池：点击模式按钮时会一起被置灰）
  const tbBtn = (label, title, fn) => {
    const b = $('button', {
      border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#cbd5e1',
      font: '11px system-ui, sans-serif', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer',
    }, { title })
    b.textContent = label
    ALL_BTNS.push(b)
    b.onclick = (e) => { e.stopPropagation(); fn() }
    return b
  }
  const tbPause = tbBtn('⏸ 暂停', '冻结/恢复页面所有动画', () => {
    const v = !animPaused
    setAnimPaused(v)
    // 单选高亮池：暂停激活时高亮自己，恢复时全部置灰
    if (v) selectOnly(tbPause); else clearAllActive()
  })
  // 检查模式（「标记」按钮）：hover 高亮 + 显示元素信息/组件链/选择器，再点退出。
  // 已有注释的角标在注释模式激活时常显（不受检查模式开关影响）。
  const tbMarkers = tbBtn('👁 标记', '悬停检查元素（信息/组件链/选择器），再点退出', () => {
    if (mode === 'inspect') {
      mode = null
      clearHover(); clearPin(); clearMulti(); closePanel()
      drag = null; dragBox.style.display = 'none'
      clearAllActive()
      return
    }
    mode = 'inspect'
    clearHover(); clearPin()
    selectOnly(tbMarkers)
  })
  const tbCopy = tbBtn('⧉ 复制', '复制结构化 Markdown（粘贴给 AI 代理）', copyToClipboard)
  const tbClear = tbBtn('🗑 清除', '删除全部注释', () => { annotations = []; renderMarkers(); sync(); toast('已清除全部注释') })
  const tbSettings = tbBtn('⚙ 设置', '设置（React 检测/标记颜色/行为）', () => openSettingsPanel())
  tbBody.append(tbMode.element, tbMode.area, tbMode.multi, tbMode.text, tbPause, tbMarkers, tbCopy, tbClear, tbSettings)
  toolbar.append(tbHead, tbBody)

  // 标记层
  const markerLayer = $('div', { position: 'fixed', inset: '0', zIndex: '2147483645', pointerEvents: 'none' })

  // ── 设置面板 ──
  const settingsPanel = $('div', {
    position: 'fixed', zIndex: '2147483647', background: THEME_BG,
    border: '1px solid rgba(255,255,255,.14)', borderRadius: '10px', color: '#e5e7eb',
    font: '12px/1.5 system-ui, sans-serif', padding: '10px 12px', width: '280px',
    boxShadow: '0 4px 24px rgba(0,0,0,.4)', display: 'none',
  })
  const stTitle = $('div', { fontSize: '11px', fontWeight: '600', marginBottom: '8px' })
  stTitle.textContent = '设置'
  const stRow = (label) => {
    const r = $('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', fontSize: '11px' })
    const l = $('span', { color: '#cbd5e1' })
    l.textContent = label
    r.appendChild(l)
    return r
  }
  // React 检测档位（紧凑 = 关闭 / 标准 = 过滤框架组件 / 取证 = 全部含框架内部）
  const stReact = stRow('React 组件检测')
  const reactRadios = $('div', { display: 'flex', gap: '6px' })
  const mkRadio = (val, label) => {
    const b = $('button', {
      border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#cbd5e1',
      font: '10.5px system-ui, sans-serif', padding: '3px 7px', borderRadius: '5px', cursor: 'pointer',
    }, { title: label })
    b.textContent = label
    b.onclick = (e) => { e.stopPropagation(); settings.reactMode = val; paintRadios(); saveSettings() }
    return b
  }
  const reactBtns = { compact: mkRadio('compact', '紧凑'), standard: mkRadio('standard', '标准'), forensic: mkRadio('forensic', '取证') }
  const paintRadios = () => {
    for (const [k, b] of Object.entries(reactBtns)) {
      b.style.background = k === settings.reactMode ? '#f59e0b' : 'transparent'
      b.style.color = k === settings.reactMode ? '#1a1a1a' : '#cbd5e1'
      b.style.borderColor = k === settings.reactMode ? '#f59e0b' : 'rgba(255,255,255,.14)'
    }
  }
  reactRadios.append(reactBtns.compact, reactBtns.standard, reactBtns.forensic)
  stReact.appendChild(reactRadios)
  // 标记颜色（元素/文本色；区域/多选固定绿）
  const stColor = stRow('标记颜色')
  const colorInput = $('input', { width: '44px', height: '22px', padding: '0', border: '1px solid rgba(255,255,255,.2)', borderRadius: '4px', background: 'transparent', cursor: 'pointer' })
  colorInput.type = 'color'
  colorInput.value = settings.color
  colorInput.onchange = () => { settings.color = colorInput.value; saveSettings() }
  stColor.appendChild(colorInput)
  // 复制后清除
  const stCopy = stRow('复制后清除')
  const copyChk = $('input', { cursor: 'pointer' })
  copyChk.type = 'checkbox'
  copyChk.checked = settings.clearOnCopy
  copyChk.onchange = () => { settings.clearOnCopy = copyChk.checked; saveSettings() }
  stCopy.appendChild(copyChk)
  // 拦截页面交互
  const stBlock = stRow('拦截页面交互')
  const blockChk = $('input', { cursor: 'pointer' })
  blockChk.type = 'checkbox'
  blockChk.checked = settings.blockInteractions
  blockChk.onchange = () => { settings.blockInteractions = blockChk.checked; saveSettings() }
  stBlock.appendChild(blockChk)
  const stClose = $('button', {
    width: '100%', marginTop: '2px', padding: '5px 0', border: 'none', borderRadius: '6px',
    background: 'rgba(255,255,255,.1)', color: '#cbd5e1', font: '11px system-ui, sans-serif', cursor: 'pointer',
  })
  stClose.textContent = '关闭'
  stClose.onclick = () => { settingsPanel.style.display = 'none' }
  settingsPanel.append(stTitle, stReact, stColor, stCopy, stBlock, stClose)
  const openSettingsPanel = () => {
    paintRadios()
    colorInput.value = settings.color
    copyChk.checked = settings.clearOnCopy
    blockChk.checked = settings.blockInteractions
    settingsPanel.style.display = 'block'
    // 定位：工具栏上方
    const tb = toolbar.getBoundingClientRect()
    settingsPanel.style.left = Math.min(Math.max(8, tb.left), window.innerWidth - 300) + 'px'
    settingsPanel.style.top = Math.max(8, tb.top - settingsPanel.offsetHeight - 10) + 'px'
  }

  // 注释面板
  const panel = $('div', {
    position: 'fixed', zIndex: '2147483647', background: THEME_BG,
    border: '1px solid rgba(255,255,255,.14)', borderRadius: '10px', color: '#e5e7eb',
    font: '12px/1.5 system-ui, sans-serif', padding: '10px 12px', width: '320px',
    boxShadow: '0 4px 24px rgba(0,0,0,.4)', display: 'none',
  })
  const panelKind = $('div', { fontSize: '10px', color: '#22c55e', fontWeight: '600', marginBottom: '4px' })
  const panelDetail = $('div', { fontSize: '11px', color: '#9ca3af', marginBottom: '4px', wordBreak: 'break-all', maxHeight: '72px', overflowY: 'auto' })
  const panelSelector = $('div', {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '10.5px', color: '#f59e0b', wordBreak: 'break-all', marginBottom: '2px',
  })
  const panelComponent = $('div', { fontSize: '10.5px', color: '#93c5fd', marginBottom: '6px', wordBreak: 'break-all' })
  // 计算样式折叠区（Agentation 同款：弹窗内展开查看 CSS 属性）
  const panelStyles = $('details', { marginBottom: '4px', fontSize: '10.5px', color: '#9ca3af' })
  const panelStylesSum = $('summary', { cursor: 'pointer', padding: '1px 0', userSelect: 'none' })
  panelStylesSum.textContent = '计算样式'
  const panelStylesBody = $('div', {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '10px', lineHeight: '1.7', marginTop: '3px', maxHeight: '140px',
    overflowY: 'auto', wordBreak: 'break-all',
  })
  panelStyles.append(panelStylesSum, panelStylesBody)
  const panelTextarea = $('textarea', {
    width: '100%', minHeight: '56px', resize: 'vertical', boxSizing: 'border-box',
    background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.16)',
    borderRadius: '6px', color: '#e5e7eb', font: '12px/1.5 system-ui, sans-serif',
    padding: '6px 8px', outline: 'none',
  }, { placeholder: '反馈内容（具体描述希望改什么）' })
  const panelActions = $('div', { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '6px' })
  const btnCancel = $('button', {
    border: 'none', background: 'rgba(255,255,255,.08)', color: '#9ca3af',
    font: '11px system-ui, sans-serif', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
  })
  btnCancel.textContent = '取消'
  const btnAdd = $('button', {
    border: 'none', background: '#f59e0b', color: '#1a1a1a',
    font: '600 11px system-ui, sans-serif', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
  })
  btnAdd.textContent = '添加注释'
  panelActions.append(btnCancel, btnAdd)
  panel.append(panelKind, panelDetail, panelSelector, panelComponent, panelStyles, panelTextarea, panelActions)

  document.documentElement.appendChild(tooltip)
  document.documentElement.appendChild(toastEl)
  document.documentElement.appendChild(toolbar)
  document.documentElement.appendChild(markerLayer)
  document.documentElement.appendChild(panel)
  document.documentElement.appendChild(settingsPanel)

  // ── 动画暂停 ──
  const freezeStyle = $('style', {})
  freezeStyle.id = 'agent-annotate-freeze'
  freezeStyle.textContent = '*{animation-play-state:paused!important;transition:none!important}'
  const setAnimPaused = (v) => {
    animPaused = v
    // 按钮高亮由单选池统一管理（selectOnly/clearAllActive），此处只管冻结效果
    if (v) { if (!document.getElementById('agent-annotate-freeze')) document.head.appendChild(freezeStyle) }
    else { freezeStyle.remove() }
    // 冻结/恢复页面视频与音频（Agentation：冻结大部分动画和视频）
    document.querySelectorAll('video, audio').forEach(m => {
      try {
        if (v) m.pause()
        else { const p = m.play(); if (p && p.catch) p.catch(() => {}) }
      } catch {}
    })
  }

  // ── 模式 ──
  // 模式互斥：任何时刻只能处于一种模式。切换时清空全部选择状态
  // （hover / pin / 多选累积 / 拖拽框），避免上一模式的标记残留到新模式。
  const setMode = (m) => {
    if (m === mode) return
    const hadMulti = m !== 'multi' && multiSel.length
    mode = m
    clearHover(); clearPin(); closePanel()
    drag = null; dragBox.style.display = 'none'
    // 切出多选且有累积：先把累积数据弹出面板提交，再清除绿色 outline
    if (hadMulti) { openPanelForMulti(); clearMulti() }
    // 单选高亮池：只高亮当前模式按钮，其余全部置灰
    selectOnly(tbMode[m])
  }

  // ── 高亮 ──
  const clearHover = () => {
    if (hoverEl) { hoverEl.style.outline = ''; hoverEl.style.outlineOffset = ''; hoverEl = null }
    tooltip.style.display = 'none'
  }
  const clearPin = () => {
    if (pinnedEl) { pinnedEl.style.outline = ''; pinnedEl.style.outlineOffset = ''; pinnedEl = null }
  }
  const paintHover = (el) => {
    el.style.outline = `2px dashed ${colorFor(mode)}`
    el.style.outlineOffset = '-2px'
    const label = [el.tagName.toLowerCase(), el.id ? '#' + el.id : '', (el.className && typeof el.className === 'string') ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''].filter(Boolean).join('')
    // tooltip 增强：元素名 + React 组件链（Agentation 悬停显示组件树）；检查模式追加 CSS 选择器
    const chain = reactChain(el)
    tooltip.textContent = (label || el.tagName.toLowerCase()) + (chain ? '\nReact: ' + chain : '')
    if (mode === 'inspect') tooltip.textContent += '\n选择器: ' + cssPath(el)
    tooltip.style.whiteSpace = 'normal'
    const r = el.getBoundingClientRect()
    tooltip.style.display = 'block'
    tooltip.style.left = Math.min(r.left, window.innerWidth - 400) + 'px'
    tooltip.style.top = Math.max(0, r.top - 30) + 'px'
  }
  const paintPin = (el) => {
    el.style.outline = `2px solid ${colorFor(mode)}`
    el.style.outlineOffset = '-2px'
  }

  // ── 拖拽框（区域 / 多选框选）──
  const dragBox = $('div', {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    border: '2px solid #22c55e', background: 'rgba(34,197,94,.14)', display: 'none',
  })
  document.documentElement.appendChild(dragBox)
  const updateDragBox = () => {
    if (!drag) { dragBox.style.display = 'none'; return }
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1)
    dragBox.style.display = 'block'
    dragBox.style.left = x + 'px'
    dragBox.style.top = y + 'px'
    dragBox.style.width = Math.abs(drag.x1 - drag.x0) + 'px'
    dragBox.style.height = Math.abs(drag.y1 - drag.y0) + 'px'
  }

  // ── 事件 ──
  const onMouseMove = (e) => {
    if (!active) return
    if (drag) {
      drag.x1 = e.clientX; drag.y1 = e.clientY
      updateDragBox()
      return
    }
    if (panelOpen || mode === 'text' || !mode) { clearHover(); return }
    const t = e.target
    if (!t || t.nodeType !== 1 || isUI(t) || t === document.documentElement || t === document.body) { clearHover(); return }
    if (mode === 'area') { clearHover(); return }
    if (hoverEl !== t) {
      clearHover()
      hoverEl = t
      paintHover(t)
    } else if (hoverEl) {
      const r = hoverEl.getBoundingClientRect()
      tooltip.style.left = Math.min(r.left, window.innerWidth - 400) + 'px'
      tooltip.style.top = Math.max(0, r.top - 30) + 'px'
    }
  }

  const onMouseDown = (e) => {
    if (!active || !mode) return
    if (isUI(e.target)) return
    // 检查模式：不拦截页面交互，仅 hover 查看
    if (mode === 'inspect') return
    // 文本模式：不拦截，允许原生拖选
    if (mode === 'text') return
    // ⇧/⌘ 拖动 = 多选框选
    if (mode === 'multi' && (e.shiftKey || e.metaKey)) {
      e.preventDefault(); e.stopPropagation()
      drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, kind: 'multi-drag' }
      updateDragBox()
      return
    }
    // 拦截页面默认行为（链接跳转/按钮提交）可由设置关闭；stopPropagation 恒有（防页面 onClick）
    if (settings.blockInteractions) e.preventDefault()
    e.stopPropagation()
    if (e.button !== 0) return
    if (mode === 'area') {
      drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, kind: 'area' }
      updateDragBox()
      return
    }
    const t = e.target
    if (mode === 'multi') {
      // 逐个点击累积（绿色高亮）；再点已选元素 = 取消
      if (multiSel.includes(t)) {
        t.style.outline = ''; t.style.outlineOffset = ''
        multiSel = multiSel.filter(el => el !== t)
      } else {
        t.style.outline = '2px solid ' + colorFor('multi')
        t.style.outlineOffset = '-2px'
        multiSel.push(t)
      }
      return
    }
    clearPin()
    pinnedEl = t
    paintPin(t)
    openPanelForElement(t, e.clientX, e.clientY)
  }

  const onMouseUp = (e) => {
    if (!active || !drag) return
    drag.x1 = e.clientX; drag.y1 = e.clientY
    updateDragBox()
    const moved = Math.abs(drag.x1 - drag.x0) + Math.abs(drag.y1 - drag.y0)
    const kind = drag.kind
    const rect = dragBox.getBoundingClientRect()
    drag = null
    dragBox.style.display = 'none'
    if (moved < 12) { clearHover(); return } // 误触
    if (kind === 'area') {
      openPanelForArea(rect)
    } else if (kind === 'multi-drag') {
      // 框选：网格采样收集范围内元素，去重后取"最外层"（不含彼此包含）
      const all = []
      for (let i = 0; i < 40; i += 2) for (let j = 0; j < 40; j += 2) {
        const el = document.elementFromPoint(rect.left + rect.width * i / 40, rect.top + rect.height * j / 40)
        if (el && el.nodeType === 1 && !isUI(el) && !all.includes(el)) all.push(el)
      }
      const filtered = all.filter(el => !all.some(other => other !== el && el.contains(other)))
      for (const el of filtered) {
        el.style.outline = '2px solid ' + colorFor('multi')
        el.style.outlineOffset = '-2px'
        if (!multiSel.includes(el)) multiSel.push(el)
      }
      if (multiSel.length) openPanelForMulti()
    }
  }

  // 文本选择：mouseup 时检查 selection
  const onTextSelect = (e) => {
    if (!active || mode !== 'text' || panelOpen) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return
    const text = sel.toString().trim()
    if (text.length > 500) return
    let el = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement
    while (el && !(el.getBoundingClientRect && el.getBoundingClientRect().width)) el = el.parentElement
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    openPanelForText(text, el, rect)
  }

  // 标记重建节流：resize/scroll 高频触发（如拖拽预览宽度）时用 rAF 合并到
  // 同一帧执行一次，避免每帧 innerHTML 重建 + getBoundingClientRect 强制重排卡顿；
  // 无注释/标记隐藏时直接跳过。
  let markerRaf = 0
  const scheduleMarkers = () => {
    if (!active || !markersVisible || !annotations.length) return
    if (markerRaf) return
    markerRaf = requestAnimationFrame(() => { markerRaf = 0; renderMarkers() })
  }
  const onScroll = () => { if (!active) return; clearHover(); scheduleMarkers() }
  const onResize = () => { if (active) scheduleMarkers() }

  const onKeyDown = (e) => {
    if (!active) return
    // 输入框聚焦时禁用快捷键（Agentation 同款）
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape') {
      if (panelOpen) closePanel()
      else if (settingsPanel.style.display === 'block') settingsPanel.style.display = 'none'
      else if (multiSel.length) clearMulti()
      else if (drag) { drag = null; dragBox.style.display = 'none' }
      else deactivate()
    } else if (e.key === 'p' || e.key === 'P') {
      // P：暂停/恢复动画
      const v = !animPaused
      setAnimPaused(v)
      if (v) selectOnly(tbPause); else clearAllActive()
    } else if (e.key === 'h' || e.key === 'H') {
      // H：显示/隐藏注释标记
      markersVisible = !markersVisible
      renderMarkers()
      toast(markersVisible ? '标记已显示' : '标记已隐藏')
    } else if (e.key === 'c' || e.key === 'C') {
      // C：复制 Markdown
      copyToClipboard()
    } else if (e.key === 'x' || e.key === 'X') {
      // X：清除全部注释
      annotations = []
      renderMarkers()
      sync()
      toast('已清除全部注释')
    }
  }

  // 全局快捷键：Ctrl/Cmd+Shift+F 切换注释模式（未激活也可唤起；输入框聚焦时禁用）
  const onGlobalKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      active ? deactivate() : activate()
    }
  }
  window.addEventListener('keydown', onGlobalKey)

  const clearMulti = () => {
    for (const el of multiSel) { el.style.outline = ''; el.style.outlineOffset = '' }
    multiSel = []
  }

  // ── 面板 ──
  let panelData = null // { kind, elements, rect, text, styles, component, url }
  const openPanel = (data, x, y, editAnn = null) => {
    panelData = data
    editingId = editAnn ? editAnn.id : null
    panelKind.textContent = '[' + MODE_LABEL[data.kind] + '模式]' + (editAnn ? ' · 编辑注释' : ' · 新注释')
    panelKind.style.color = colorFor(data.kind)
    panelSelector.textContent = ''
    panelComponent.textContent = ''
    if (data.kind === 'area') {
      panelDetail.textContent = `区域 ${Math.round(data.rect.w)}×${Math.round(data.rect.h)} @ (${Math.round(data.rect.x)}, ${Math.round(data.rect.y)}) · 覆盖 ${data.elements.length} 个元素`
    } else if (data.kind === 'multi') {
      panelDetail.textContent = '已选 ' + data.elements.length + ' 个元素：'
      panelDetail.title = data.elements.map(e => e.selector).join('\n')
      panelSelector.textContent = data.elements.slice(0, 3).map(e => e.selector).join('\n') + (data.elements.length > 3 ? `\n…共 ${data.elements.length} 个` : '')
    } else if (data.kind === 'text') {
      panelDetail.textContent = '引用文本（已包含在输出中）'
      panelSelector.textContent = (data.text || '').slice(0, 120)
      if (data.elements[0]) panelSelector.textContent += '\n' + data.elements[0].selector
    } else {
      panelDetail.textContent = data.elements[0]?.summary || '(无文本内容)'
      panelSelector.textContent = data.elements[0]?.selector || ''
      panelComponent.textContent = data.component ? `React: ${data.component}` : ''
    }
    // 计算样式折叠区填充（默认收起，点开查看；textContent 防页面内容注入）
    panelStyles.open = false
    panelStylesBody.replaceChildren()
    const styleRows = Object.entries(data.styles || {})
    panelStylesSum.textContent = styleRows.length ? `计算样式（${styleRows.length}）` : '计算样式'
    for (const [k, v] of styleRows) {
      const row = $('div', {})
      const kk = $('span', { color: '#9ca3af' })
      kk.textContent = k + ': '
      const vv = $('span', { color: '#e5e7eb' })
      vv.textContent = v
      row.append(kk, vv)
      panelStylesBody.appendChild(row)
    }
    panelTextarea.value = editAnn ? editAnn.note : ''
    panel.style.display = 'block'
    panel.style.left = Math.min(Math.max(8, x), window.innerWidth - 340) + 'px'
    panel.style.top = Math.min(Math.max(8, y + 12), window.innerHeight - 260) + 'px'
    panelOpen = true
    clearHover()
    setTimeout(() => panelTextarea.focus(), 0)
  }

  const openPanelForElement = (el, x, y) => {
    openPanel({
      kind: 'element',
      elements: [elemInfo(el)],
      styles: computedInfo(el),
      component: reactChain(el),
      url: location.href,
    }, x, y)
  }

  const openPanelForArea = (rect) => {
    const all = []
    for (let i = 0; i < 40; i += 2) for (let j = 0; j < 40; j += 2) {
      const el = document.elementFromPoint(rect.left + rect.width * i / 40, rect.top + rect.height * j / 40)
      if (el && el.nodeType === 1 && !isUI(el) && !all.includes(el)) all.push(el)
    }
    const filtered = all.filter(el => !all.some(other => other !== el && el.contains(other))).slice(0, 12)
    openPanel({
      kind: 'area',
      elements: filtered.map(elemInfo),
      // rect 存视口坐标 + 标注时的滚动偏移：页面滚动后渲染时换算，标记框跟随页面
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height, sx: window.scrollX, sy: window.scrollY },
      styles: {},
      component: '',
      url: location.href,
    }, rect.left, rect.top)
  }

  const openPanelForMulti = () => {
    const first = multiSel[0] || document.body
    openPanel({
      kind: 'multi',
      elements: multiSel.map(elemInfo),
      styles: computedInfo(first),
      component: reactChain(first),
      url: location.href,
    }, 40, 60)
  }

  const openPanelForText = (text, el, rect) => {
    const info = el ? elemInfo(el) : { selector: '', tag: '', name: '', summary: '' }
    openPanel({
      kind: 'text',
      elements: [info],
      text,
      styles: el ? computedInfo(el) : {},
      component: el ? reactChain(el) : '',
      url: location.href,
    }, rect.left, rect.bottom + 6)
  }

  const closePanel = () => {
    panel.style.display = 'none'
    panelOpen = false
    editingId = null
    if (mode === 'multi') return // 多选累积保留
    // 添加/取消后都清除元素残留 outline（角标已足够标识注释位置）
    clearPin()
    panelData = null
  }

  btnCancel.addEventListener('click', (e) => { e.stopPropagation(); closePanel() })
  btnAdd.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!panelData) return
    panelData.note = panelTextarea.value.trim()
    if (!panelData.note) { toast('请填写反馈内容'); return }
    panelData.id = editingId || newId()
    panelData.ts = Date.now()
    if (editingId) {
      annotations = annotations.map(a => a.id === editingId ? panelData : a)
    } else {
      annotations.push(panelData)
    }
    if (mode === 'multi') clearMulti()
    closePanel()
    renderMarkers()
    sync()
  })

  // ── 标记管理 ──
  const findEl = (selector) => {
    try { return document.querySelector(selector) } catch { return null }
  }

  const renderMarkers = () => {
    markerLayer.innerHTML = ''
    if (!active || !markersVisible) return
    annotations.forEach((a, idx) => {
      const n = idx + 1
      const color = colorFor(a.kind)
      const mkBadge = (rect) => {
        const b = $('button', {
          position: 'fixed', left: rect.right + 4 + 'px', top: rect.top - 4 + 'px',
          minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '8px',
          background: color, color: '#1a1a1a', border: 'none', cursor: 'pointer',
          font: '700 10px/16px system-ui, sans-serif', pointerEvents: 'auto',
          boxShadow: '0 1px 4px rgba(0,0,0,.4)',
        }, { title: '点击移除 · 右键编辑' })
        b.textContent = String(n)
        b.onclick = (ev) => { ev.stopPropagation(); annotations = annotations.filter(x => x.id !== a.id); renderMarkers(); sync() }
        b.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          openPanel({ ...a, kind: a.kind }, 40, 60, a)
        }
        return b
      }
      if (a.kind === 'area' && a.rect) {
        // 文档坐标换算：标注时视口坐标 + 标注时滚动偏移 - 当前滚动偏移 → 标记跟随页面
        const ox = a.rect.x + ((a.rect.sx || 0) - window.scrollX)
        const oy = a.rect.y + ((a.rect.sy || 0) - window.scrollY)
        const box = $('div', {
          position: 'fixed', left: ox + 'px', top: oy + 'px',
          width: a.rect.w + 'px', height: a.rect.h + 'px',
          border: '2px solid ' + color, background: 'rgba(34,197,94,.10)',
        }, { title: a.note })
        markerLayer.appendChild(box)
        markerLayer.appendChild(mkBadge({ right: ox + a.rect.w, top: oy }))
      } else {
        a.elements.forEach(e => {
          const el = findEl(e.selector)
          if (!el) return
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) return
          markerLayer.appendChild(mkBadge({ right: r.right, top: r.top }))
        })
      }
    })
  }

  // ── 工具栏拖动 ──
  let dragTb = null
  tbHead.addEventListener('pointerdown', (e) => {
    if (e.target === tbExit) return
    dragTb = { dx: e.clientX - toolbar.offsetLeft, dy: e.clientY - toolbar.offsetTop }
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (!dragTb) return
    toolbar.style.left = Math.max(4, e.clientX - dragTb.dx) + 'px'
    toolbar.style.top = Math.max(4, e.clientY - dragTb.dy) + 'px'
    toolbar.style.right = 'auto'
    toolbar.style.bottom = 'auto'
  })
  window.addEventListener('pointerup', () => { dragTb = null })

  // ── 激活 / 退出 ──
  const activate = () => {
    active = true
    bindEvents()
    toolbar.style.display = 'flex'
    // 初始高亮：仅当前模式按钮（单选池）；上次处于检查模式则点亮「标记」
    clearAllActive()
    if (mode === 'inspect') setBtnVisual(tbMarkers, true)
    else setBtnVisual(tbMode[mode] || tbMode.element, true)
    renderMarkers()
    sync()
  }
  const deactivate = () => {
    active = false
    unbindEvents()
    toolbar.style.display = 'none'
    clearHover(); clearPin(); clearMulti(); closePanel()
    setAnimPaused(false)
    markerLayer.innerHTML = ''
    drag = null; dragBox.style.display = 'none'
    sync()
  }
  tbExit.addEventListener('click', (e) => { e.stopPropagation(); deactivate() })

  // ── 事件绑定：仅在注释模式激活时绑定、退出时解绑 ──
  // 未激活时 iframe 内零监听器（零事件开销），排除注入本身对页面性能的影响。
  const bindEvents = () => {
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('mouseup', onTextSelect, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('keydown', onKeyDown, true)
  }
  const unbindEvents = () => {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('mouseup', onTextSelect, true)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  // ── 恢复本页历史注释（7 天内，刷新/重开保留）──
  try {
    const key = STORAGE_KEY + ':' + location.host + location.pathname
    const raw = localStorage.getItem(key)
    if (raw) {
      const saved = JSON.parse(raw)
      if (saved && Array.isArray(saved.annotations) && Date.now() - (saved.ts || 0) < 7 * 24 * 3600 * 1000) {
        annotations = saved.annotations.filter(a => a && a.id)
      } else {
        localStorage.removeItem(key)
      }
    }
  } catch {}

  // ── 宿主控制接口 ──
  window.__agentAnnotate = {
    toggle: () => { active ? deactivate() : activate() },
    activate,
    deactivate,
    setMode,
    clear: () => { annotations = []; clearMulti(); renderMarkers(); sync() },
    removeById: (id) => { annotations = annotations.filter(a => a.id !== id); renderMarkers(); sync() },
    count: () => annotations.length,
    list: () => annotations.slice(),
    snapshot: () => ({ active, annotations: annotations.slice() }),
  }
  sync()
})()
