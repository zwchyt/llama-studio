// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-task —— 待办卡片视觉组件（滚动数字 + 三态图标）                   ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx「区域：待办卡片视觉组件（滚动数字 + 三态图标，对齐
// TodoList 演示设计）」，逻辑与注释均未改动，仅补齐 import。
//
// 对外导出：RollDigit、TaskRollingCount、taskIconCls、TaskCheckIcon、TaskArrowIcon、
//           TaskDashedIcon、TaskXIcon、TaskFilledCheckIcon、TaskPieIcon、TaskPlanCard

import React, { useEffect, useRef, useState } from 'react'
import type { TodoUpdate } from '../../../../../shared/types'

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：待办卡片视觉组件（滚动数字 + 三态图标，对齐 TodoList 演示设计）        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// 单个数字槽：字符变化时旧字符上滚、新字符滚入
export const RollDigit = React.memo(function RollDigit({ char }: { char: string }) {
  const prev = useRef(char)
  const [roll, setRoll] = useState<{ from: string; to: string } | null>(null)
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (char === prev.current) return
    const from = prev.current
    prev.current = char
    setRoll({ from, to: char })
    setUp(false)
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setUp(true)))
    const done = setTimeout(() => setRoll(null), 380)
    return () => { cancelAnimationFrame(raf); clearTimeout(done) }
  }, [char])
  if (!roll) return <span className="agent-task-roll-digit">{char}</span>
  return (
    <span className="agent-task-roll-digit">
      <span className={`agent-task-roll-inner${up ? ' on' : ''}`}>
        <span>{roll.from}</span>
        <span>{roll.to}</span>
      </span>
    </span>
  )
})

// 任务计数（如 2/5），字符级滚动
export const TaskRollingCount = ({ value }: { value: string }) => (
  <span className="agent-task-roll-count" aria-label={value}>
    {value.split('').map((c, i) => <RollDigit key={i} char={c} />)}
  </span>
)

// 任务状态图标三态（pending 虚线圆 / in_progress 箭头 / completed 对勾）+ cancelled 叉
export const taskIconCls = (base: string, on?: boolean) => base + (on ? ' on' : '')
export const TaskCheckIcon = ({ on }: { on?: boolean }) => (
  <svg className={taskIconCls('agent-task-todo-icon', on)} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const TaskArrowIcon = ({ on }: { on?: boolean }) => (
  <svg className={taskIconCls('agent-task-todo-icon strong', on)} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const TaskDashedIcon = ({ on }: { on?: boolean }) => (
  <svg className={taskIconCls('agent-task-todo-icon', on)} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.8 3.6" strokeLinecap="round" />
  </svg>
)
export const TaskXIcon = ({ on }: { on?: boolean }) => (
  <svg className={taskIconCls('agent-task-todo-icon', on)} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M9 9l6 6m0-6-6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
// 头部全完成实心对勾
export const TaskFilledCheckIcon = () => (
  <svg className="agent-task-head-check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" fill="currentColor" />
  </svg>
)

// 头部进度饼图：SVG 虚线外环 + 填充弧（stroke-dasharray 过渡，无 @property 依赖）
export const TaskPieIcon = ({ pct }: { pct: number }) => {
  const R = 8.5
  const circ = 2 * Math.PI * R
  const filled = (circ * Math.max(0, Math.min(100, pct))) / 100
  return (
    <svg className="agent-task-head-pie" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <circle className="agent-task-head-pie-ring" cx="10" cy="10" r={R} fill="none" strokeWidth="2" strokeDasharray="2 3.4" strokeLinecap="round" />
      <circle
        className="agent-task-head-pie-fill"
        cx="10" cy="10" r={R} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`}
        transform="rotate(-90 10 10)"
      />
    </svg>
  )
}

// 待办清单卡片（会话区右上角浮层）。单独成组件并 memo：卡片数据只在 TodoWrite 更新时才变，
// 而布局组件在流式期间每个 token 都重渲染，不 memo 的话整棵卡片子树跟着逐帧重画。
export const TaskPlanCard = React.memo(function TaskPlanCard({ items, planTitle, doneCount }: {
  items: TodoUpdate[]
  planTitle: string
  doneCount: number
}) {
  // 已出现过的项 id：只有新 id 才挂 .enter 播级联入场，刷新已有项状态不重放动画
  const seenRef = useRef<Set<string>>(new Set())
  const allDone = items.length > 0 && doneCount === items.length
  return (
    <div className="agent-task-card">
      <div className="agent-task-card-head">
        <span className="agent-task-card-head-icon">
          {allDone ? (
            <TaskFilledCheckIcon />
          ) : items.length > 0 ? (
            <TaskPieIcon pct={Math.round((doneCount / items.length) * 100)} />
          ) : (
            <TaskDashedIcon on />
          )}
        </span>
        <span className="agent-task-card-title">待办</span>
        <span className="agent-task-card-count"><TaskRollingCount value={`${doneCount}/${items.length}`} /></span>
      </div>
      {planTitle && (
        <div className="agent-task-card-plan-title">{planTitle}</div>
      )}
      <div className="agent-task-card-body">
        {items.length === 0 ? (
          <div className="agent-task-card-empty">暂无计划</div>
        ) : (
          items.map((item, i) => {
            // 显式覆盖全部状态枚举，避免 cancelled 被 fallback 成「待完成」
            const raw = item.status || 'pending'
            const isDone = raw === 'completed'
            const isActive = raw === 'in_progress'
            const isCancelled = raw === 'cancelled'
            // 每条只显示一行：进行中且有备注(notes)时，备注作为 activeForm 显示；
            // 否则显示 content。notes 不作为独立第二行渲染。
            const text = raw === 'in_progress' && item.notes
              ? item.notes
              : (item.content || item.description || '')
            // 用稳定 id 作为 key（无 id 时回退下标），减少 merge 导致顺序变化时 DOM 复用错乱
            const key = item.id ?? String(i + 1)
            const enter = !seenRef.current.has(key)
            seenRef.current.add(key)
            return (
              <div
                key={key}
                className={`agent-task-card-item${isDone ? ' done' : ''}${isActive ? ' active' : ''}${enter ? ' enter' : ''}`}
                style={{ ['--i' as string]: i }}
              >
                <span className="agent-task-iconwrap">
                  <TaskDashedIcon on={!isDone && !isActive && !isCancelled} />
                  <TaskArrowIcon on={isActive} />
                  <TaskCheckIcon on={isDone} />
                  <TaskXIcon on={isCancelled} />
                </span>
                <div className="agent-task-card-content">
                  <div className="agent-task-card-text">{text}</div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
})

