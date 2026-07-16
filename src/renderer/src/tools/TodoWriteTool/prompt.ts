export function getTodoWritePrompt(): string {
  return `# TodoWrite 工具使用说明

创建并管理结构化的**待办清单**。清单对用户实时可见，是你展示进度的主要方式。

TodoWrite 是唯一的任务管理工具。创建、更新状态、记录结果、取消任务全部用它完成。

## 适用场景
- 复杂多步任务（≥3 步）开始前做计划
- 用户明确要求使用待办清单时
- 接到一串任务（编号 / 逗号分隔）时立即记录
- 开始某项任务前把它标记为 in_progress
- 完成某项后标记为 completed，并补充新发现的子任务
- 记录任务结果或产出（用 notes 字段）

## 不适用
- 只有单一、琐碎的任务时，直接做即可，不必调用

## 两种模式

### merge 模式（默认）
部分更新，按 id 合并到现有清单：
- **已有项**：只传要改的字段。{id, status: "completed"} 即可标记完成
- **记录结果**：{id, notes: "已修复，验证通过"} 追加备注
- **新增项**：content 可省略，id 会作为兜底内容

### replace 模式（merge=false）
完全替换整个清单，适用于初始化或大规模重组。

## 字段说明
| 字段 | 必填 | 说明 |
|------|------|------|
| id | 推荐 | 稳定的唯一标识，省略则自动生成 |
| content | 推荐 | 简短可执行的标题（祈使句）；merge 已有项时省略保留旧值 |
| description | 可选 | 任务的详细描述与上下文 |
| status | 推荐 | pending / in_progress / completed / cancelled |
| priority | 可选 | high / medium（默认）/ low |
| activeForm | 可选 | 进行中时在状态栏展示的现在分词形式 |
| notes | 可选 | 执行结果/产出备注（供 TaskOutput 读取） |

## 最佳实践
- 使用**稳定 id**，不要每次重新生成
- 翻转状态时只传 {id, status} 减少 token
- 记录结果时只传 {id, notes} 不干扰其他字段
- 探索型任务中标记死胡同为 cancelled 而非删除
- 本工具与 TaskGet / TaskList / TaskOutput 共享同一份任务清单`
}
