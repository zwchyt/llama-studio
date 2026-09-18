// 文档 → 纯文本抽取工具：知识库摄入与 Agent Code 附件共用。
// pdfjs / mammoth 只在浏览器侧解析，所以工作区里的 PDF 要先读成 Buffer 再走 extractTextFromBuffer。
import { getDocument } from 'pdfjs-dist'
import mammoth from 'mammoth'
// 注册 pdf worker（fake worker 回退用）
import 'pdfjs-dist/build/pdf.worker.js'

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
      const result = await mammoth.extractRawText({ arrayBuffer: buffer })
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
