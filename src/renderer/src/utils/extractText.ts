// 文档 → 纯文本抽取工具：供知识库摄入使用。
// 复用 ChatView 的解析思路（pdfjs / mammoth / FileReader），但独立成 util，
// 不改动 ChatView 自身的 readFileContent，保持组件隔离。
import { getDocument } from 'pdfjs-dist'
import mammoth from 'mammoth'
// 注册 pdf worker（fake worker 回退用），与 ChatView 一致
import 'pdfjs-dist/build/pdf.worker.js'

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name)
}
function isDocx(name: string): boolean {
  return /\.docx$/i.test(name)
}

// 从 File 抽取纯文本；不支持的二进制类型返回空字符串（调用方跳过）
export async function extractTextFromFile(file: File): Promise<string> {
  const isImage = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(file.name)
  if (isImage) return ''

  if (isPdf(file.name)) {
    try {
      const buffer = await file.arrayBuffer()
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

  if (isDocx(file.name)) {
    try {
      const buffer = await file.arrayBuffer()
      const result = await mammoth.extractRawText({ arrayBuffer: buffer })
      return result.value
    } catch {
      return ''
    }
  }

  // 其余按纯文本读取（txt/md/代码等）
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.readAsText(file)
  })
}
