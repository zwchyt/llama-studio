// browser_show 的工具结果卡片：结果 JSON 形如 { ok, type, title, url }，
// 其中 url 是 file:// 形式且经过百分号转义（例如
// file:///E:/llama-studio/%E6%96%B0%E5%BB%BA%20...），直接打印原文读不出「打开了什么」。
//
// 这里把它摊成项目统一的「标签 | 值」结果框（.agent-tool-result + .agent-tool-io-group），
// 字段一个都不省略：状态 / 类型 / 标题 / 地址（有 error 时追加错误行）。
// 只做结构化和可读性加工（布尔转中文、URL 解码），不改内容。
import { useMemo } from 'react'
import ToolResultRows, { RawResultFallback, buildResultRows, parseResultObject } from './ToolResultRows'

export default function BrowserShowResult({ result }: { result?: string }) {
  const parsed = useMemo(() => parseResultObject(result), [result])
  const rows = useMemo(() => (parsed ? buildResultRows(parsed) : []), [parsed])
  // 结果不是预期 JSON（例如异常文本）：直接把原文放进结果框，不丢内容
  if (!parsed) return <RawResultFallback result={result} />
  return (
    <div className="agent-tool-result">
      <div className="agent-tool-result-head">
        <span className="agent-tool-result-label">结果</span>
      </div>
      <ToolResultRows rows={rows} />
    </div>
  )
}
