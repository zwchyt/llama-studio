// 文件预览面板的 PDF 版面渲染：pdf.js 把每页画到 canvas。
// 只读；渲染结果不缓存——关掉标签即销毁文档，重新打开再解析一遍。
// 与「附件文本预览」（AttachmentTextPreview）不是一回事：那边是模型读到的抽取文本，
// 这边是人看的版面。

import React, { useEffect, useRef, useState } from 'react'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
// 注册 worker（缺失时 pdf.js 走 fake worker 回退）。utils/extractText.ts 里那份 import
// 是同一个模块，打包后只有一份实例，这里再写一次是为了本组件可独立成立。
import 'pdfjs-dist/build/pdf.worker.js'

function PdfPageView({ pdf, num }: {
  pdf: PDFDocumentProxy
  num: number
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  // 画这一页时用的容器宽度与像素比：位图尺寸是一次定死的，事后宽度变了就会被拉伸发虚
  const drawnAtRef = useRef<{ w: number; dpr: number } | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [failed, setFailed] = useState(false)

  // 先只取页面尺寸（元数据，不渲染）：占位框按真实宽高比撑住滚动高度，
  // 未渲染的页不会把整列压扁，滚动条位置也不会随渲染进度跳动。
  useEffect(() => {
    let cancelled = false
    pdf.getPage(num)
      .then(p => {
        if (cancelled) return
        const vp = p.getViewport({ scale: 1 })
        setBox({ w: vp.width, h: vp.height })
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [pdf, num])

  async function draw(): Promise<void> {
    const el = wrapRef.current
    const canvas = canvasRef.current
    if (!el || !canvas || !box) return
    try {
      const page = await pdf.getPage(num)
      // 铺满面板宽度；面板收起时 clientWidth 为 0，取下限避免 0 尺寸画布。
      // 再乘 dpr 画到物理像素，文字边缘才不会发虚（canvas 仍以 100% 宽度显示）。
      const cssW = Math.max(320, el.clientWidth)
      const dpr = window.devicePixelRatio || 1
      // 位图多画 40% 余量：面板展开有 0.25s 的宽度过渡，首帧量到的宽度往往偏小。
      // 位图比显示尺寸大只是轻微下采样（看着仍清晰），小了就会被拉伸发虚；
      // 余量兜住动画期间，下面的 ResizeObserver 兜住之后被拖得更宽的情况。
      const headroom = 1.4
      const viewport = page.getViewport({ scale: (cssW * dpr * headroom) / box.w })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({ canvasContext: ctx, viewport })
      renderTaskRef.current = task
      await task.promise
      renderTaskRef.current = null
      drawnAtRef.current = { w: cssW * headroom, dpr }
      setDrawn(true)
    } catch {
      renderTaskRef.current = null
      setFailed(true)
    }
  }

  // 滚到视口附近才画：几百页的文档一次全画，等于一次要下几百张 canvas 的显存。
  // root 用默认的视口——滚动的是外层 .agent-code-preview-body，本元素自己不成滚动容器。
  useEffect(() => {
    const el = wrapRef.current
    if (!el || drawn || !box) return
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      io.disconnect()
      void draw()
    }, { rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [box, drawn])

  // 卸载时还有渲染在跑：取消，否则 pdf.js 会往已卸载的 canvas 上画并抛异常
  useEffect(() => () => { renderTaskRef.current?.cancel() }, [])

  // 面板展开有 0.25s 的 max-width 过渡（.agent-code-preview-group），此外拖拽调宽、
  // 系统缩放变化同理：canvas 位图是画那一刻按当时宽度定死的，事后宽度变了不重画就会被
  // CSS 拉伸 → 糊。退回未渲染态即可，上面的 IntersectionObserver 会立刻用新宽度重画一遍。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let timer = 0
    const ro = new ResizeObserver(() => {
      // 展开动画里宽度是连着的：等它稳住再判，否则一路重画十几轮
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const at = drawnAtRef.current
        if (!at) return
        // at.w = 当前位图撑得住的显示宽度（含首帧那份余量）。只有真被拖到接近/超过它
        // 才重画，否则每拖一下都要白重绘一轮；像素比变了（换屏 / 系统缩放）同理。
        if (el.clientWidth > at.w * 0.98 || at.dpr !== (window.devicePixelRatio || 1)) setDrawn(false)
      }, 150)
    })
    ro.observe(el)
    return () => { window.clearTimeout(timer); ro.disconnect() }
  }, [])

  return (
    <div
      className="pdf-page"
      ref={wrapRef}
      style={box ? { aspectRatio: `${box.w} / ${box.h}` } : undefined}
    >
      <canvas ref={canvasRef} />
      {!drawn && (
        <div className="pdf-page-state">{failed ? `第 ${num} 页渲染失败` : box ? '渲染中…' : '读取页面…'}</div>
      )}
    </div>
  )
}

export function PdfViewer({ data }: { data: Uint8Array }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    // 必须传副本：pdf.js 会把 data 背后的 ArrayBuffer 移交（transfer）给 worker，
    // 传原数组会让标签里存的那份 pdfData 变成 detach 的空壳，切回来就画不出了。
    getDocument({ data: new Uint8Array(data) }).promise
      .then(d => {
        if (cancelled) { void d.destroy(); return }
        doc = d
        setPdf(d)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`PDF 解析失败：${e instanceof Error ? e.message : String(e)}`)
      })
    return () => {
      cancelled = true
      void doc?.destroy()
    }
  }, [data])

  return (
    <div className="pdf-viewer">
      {error
        ? <div className="agent-code-preview-error">{error}</div>
        : !pdf
          ? <div className="file-tree-loading">解析 PDF…</div>
          : Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPageView key={i} pdf={pdf} num={i + 1} />
          ))}
    </div>
  )
}
