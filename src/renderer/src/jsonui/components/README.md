# jsonui 组件目录

本目录每个文件对应一个 LLM 可生成的 UI 卡片。模型输出 JSON spec 后由 `registry.tsx` 拼装渲染。

## 卡片清单

| 文件 | 卡片名 | 用途 | 关键 props | emit |
|---|---|---|---|---|
| `GpuUsagePanel.tsx` | `GpuUsagePanel` | GPU 显存/利用率/温度 | `engine`, `utilization?`, `memoryUsedMb?`, `memoryTotalMb?`, `temperature?` | — |
| `MessageCard.tsx` | `MessageCard` | 通用提示卡片（纯展示） | `variant`, `title`, `message` | — |
| `Chart.tsx` | `Chart` | 简单图表（折线/柱状/饼图） | `type`, `title?`, `data`, `xKey`, `yKey` | — |
| `MermaidCard.tsx` | `MermaidCard` | ~~已迁移到 `../mermaid/`~~ | — | — |

> **Mermaid 模块已独立**：`MermaidCard` 和 `parseContentToBlocks` 已迁移到 `src/renderer/src/mermaid/` 目录。本目录不再包含 Mermaid 相关代码。`registry.tsx` 通过 `import { MermaidCard } from '../mermaid'` 引用。

## 添加新卡片流程

> 当前架构下，必须同时改 4 个文件（schema/注册/校验/提示词），无法只在 `components/` 下加文件就完事——这是当前设计的限制。

1. 在本目录新建 `YourCard.tsx`，导出 `function YourCard({ props, emit, children })`
2. 在 `../catalog.ts` 用 Zod 声明 schema 并加到 `components` 里
3. 在 `../registry.tsx` 顶部 import + 在 `defineRegistry` 的 `components` 里加一行
4. 在 `../specGen.ts` 的 `COMPONENT_WHITELIST` 加一行（否则 LLM 输出该组件会被拒）
5. 在 `../../shared/agentGuidance.ts` 的 prompt 列表加一行（否则 LLM 不知道能选这个组件）

**可选**：
- emit 新事件名 → `../catalog.ts` 的 `actions` 同步声明 + `../defaultHandlers.ts` 注册占位
- 需要新样式 → 往 `../jsonui.css` 加 `.jui-xxx` 类

**为什么要改这些地方**（理解清楚再动）：
- `catalog.ts` — LLM 看到的"我能用哪些组件"清单，少了它 schema 报错
- `registry.tsx` — JSON 里的 type → React 组件 的映射，少了它运行时找不到组件
- `specGen.ts` — 客户端二次校验白名单，少了它 LLM 输出合法但被拒
- `agentGuidance.ts` — 喂给 LLM 的 system prompt，少了它 LLM 不会主动用这个组件

## 复用 helper

`../shared/` 提供跨卡片复用：
- `MetricView` — `label + value` 小卡（InferenceMetrics / GpuUsagePanel 内部用）
- `severityColor` — info/warning/critical/error/success → CSS 变量
