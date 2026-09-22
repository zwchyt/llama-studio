// 文档 → 纯文本抽取工具：知识库摄入与 Agent Code 附件共用。
// pdfjs / mammoth 只在浏览器侧解析，所以工作区里的 PDF 要先读成 Buffer 再走 extractTextFromBuffer。
//
// ── 按需加载（内存优化）──
// pdfjs+worker（≈2MB）与 mammoth（≈700KB）只在「真的要解析 PDF/DOCX」那一刻才需要。
// 此前为顶层静态 import，被打进首屏主 bundle：应用一启动就解析并常驻堆里。
// 改为函数内动态 import + 模块级缓存（首次加载后复用，无重复开销）。
// worker 语义与原静态 import 完全一致：先加载 pdfjs、随后注册 worker 模块
// （fake worker 回退时同步拿到 WorkerMessageHandler，不新增运行时获取路径）。
type PdfjsModule = typeof import('pdfjs-dist')
type MammothModule = typeof import('mammoth')
let pdfjsPromise: Promise<PdfjsModule> | null = null
let mammothPromise: Promise<MammothModule> | null = null

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    // 注册 pdf worker（fake worker 回退用）——加载顺序与原静态 import 一致
    await import('pdfjs-dist/build/pdf.worker.js')
    return pdfjs
  })()
  return pdfjsPromise
}

function loadMammoth(): Promise<MammothModule> {
  mammothPromise ??= import('mammoth')
  return mammothPromise
}

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name)
}
function isDocx(name: string): boolean {
  return /\.docx$/i.test(name)
}

/** 需要（也只能）靠二进制解析才能拿到文本的文件，readAsText 会得到乱码 */
export function isBinaryDoc(name: string): boolean {
  return isPdf(name) || isDocx(name)
}

export function binaryDocLabel(name: string): string {
  return isPdf(name) ? 'PDF' : isDocx(name) ? 'DOCX' : 'DOC'
}

// 从已读出的 Buffer 抽取纯文本；解析失败返回空字符串（调用方跳过）
export async function extractTextFromBuffer(name: string, buffer: ArrayBuffer): Promise<string> {
  if (isPdf(name)) {
    try {
      const { getDocument } = await loadPdfjs()
      const pdf = await getDocument({ data: buffer }).promise
      const texts: string[] = []
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p)
        const tc = await page.getTextContent()
        texts.push(tc.items.map((item: unknown) => (item as { str?: string }).str ?? '').join(' '))
      }
      return texts.join('\n')
    } catch {
      return ''
    }
  }

  if (isDocx(name)) {
    try {
      const { extractRawText } = await loadMammoth()
      const result = await extractRawText({ arrayBuffer: buffer })
      return result.value
    } catch {
      return ''
    }
  }

  try {
    return new TextDecoder().decode(buffer)
  } catch {
    return ''
  }
}

// 从 File 抽取纯文本；图片返回空字符串（调用方按图片分支处理）
export async function extractTextFromFile(file: File): Promise<string> {
  const isImage = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(file.name)
  if (isImage) return ''

  if (isBinaryDoc(file.name)) return extractTextFromBuffer(file.name, await file.arrayBuffer())

  // 其余按纯文本读取（txt/md/代码等）
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.readAsText(file)
  })
}
