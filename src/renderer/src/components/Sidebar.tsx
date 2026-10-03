import React, { useCallback, useEffect, useRef, useState, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import { useSidebarStore } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import {
  MODE_ITEMS,
  NAV_ITEMS,
  NAV_TAIL_ITEMS,
  TOOLS_ENTRY,
  GROUPED_VIEWS,
  navKeyOf,
  resolveToolsEntryView
} from '../utils/navConfig'
import type { NavDef } from '../utils/navConfig'
import { playNavSound } from '../utils/sound'
import { AGENT_SESSION_SLOT_ID } from './agent-code/agent-session/slotId'
import { preloadViewOnHover } from '../views/viewRegistry'
import '../styles/sidebar.css'

// 导航清单已统一收敛到 utils/navConfig.ts：NAV_ITEMS / NAV_TAIL_ITEMS 是常驻项，
// 两段中间夹着「工具箱」入口（这样「设置」才落在导航最末）；
// 「对话 / 工作台」两项在 MODE_ITEMS 里、渲染进底部 Agent Code 槽（见下方）；
// 收进「工具箱」页的低频界面在 TOOL_GROUPS 里。本组件只负责渲染。

interface NavItemProps {
  /** 图标。可省略——省略时只渲染文字（「聊天 / 编码」模式切换就是纯文字按钮：
   *  它们的图标在侧栏里没有信息增量，反而是收起/展开时最容易看出抖动的地方）。 */
  icon?: React.ElementType
  label: string
  active?: boolean
  onClick?: () => void
  /** 鼠标移入时触发：用于提前拉取该视图的 chunk（见 views/viewRegistry 的 preloadViewOnHover） */
  onHover?: () => void
  /** 悬停进出时把自身元素交给上层，用于在收起态弹出标签气泡（传 null 表示移出）。
   *  位置由上层实测，本组件只负责"我是谁、我在哪"——气泡要挂到 body 上，
   *  只能由上层统一渲染一份，见 Sidebar 的 tip 状态。 */
  onTip?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  children?: React.ReactNode
  className?: string
}

const NavItem = forwardRef<{ startAnimation: () => void; stopAnimation: () => void }, NavItemProps>(
  ({ icon: Icon, label, active, onClick, onHover, onTip, style, children, className = '' }, ref) => {
    const innerRef = useRef<{ startAnimation: () => void; stopAnimation: () => void } | null>(null)

    React.useImperativeHandle(ref, () => ({
      startAnimation: () => innerRef.current?.startAnimation(),
      stopAnimation: () => innerRef.current?.stopAnimation(),
    }))

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        innerRef.current?.startAnimation()
        onHover?.()
        onTip?.(e.currentTarget)
      },
      [onHover, onTip]
    )

    const handleMouseLeave = useCallback(() => {
      innerRef.current?.stopAnimation()
      onTip?.(null)
    }, [onTip])

    return (
      <button
        className={`nav-item ${active ? 'active' : ''} ${className}`}
        onClick={onClick}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        /* 收起态文字被 CSS 裁掉，按钮就失去了可读的名字（图标不带语义），
           所以 data-label / aria-label 是**必需**的，不只是给气泡用的取词源。
           展开态两者一致，覆盖掉可见文字也不产生差异。 */
        data-label={label}
        aria-label={label}
        type="button"
      >
        {Icon && <Icon ref={innerRef as any} size={16} className="nav-animate-icon" />}
        <span>{label}</span>
        {children}
      </button>
    )
  }
)

NavItem.displayName = 'NavItem'

export default function Sidebar() {
  const { collapsed, collapsing, hoverExpanded, hoverExpandEnabled, setHoverExpanded } = useSidebarStore()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const { view, setView, agentMode, setAgentMode } = useStore(
    s => ({ view: s.view, setView: s.setView, agentMode: s.agentMode, setAgentMode: s.setAgentMode }),
    shallow
  )

  // ── 悬浮展开 / 收起：必须走原生 mouseenter / mouseleave，不能用 React 合成事件 ──
  // 会话列表是经 portal 挂进 .sidebar-agent-slot 的（见 AgentCodeViewLayout 的 createPortal）：
  // DOM 上它是 .sidebar-wrapper 的后代，React 树里却属于另一棵子树。合成 mouseleave 沿
  // fiber 树判定归属，于是「从导航项滑到列表」会被误判成离开整个侧栏——列表还没点就先收起；
  // 反过来「从列表直接滑出侧栏」时，列表不在 React 祖先链上，事件又根本不来。
  // 原生事件按 DOM 子树判定，两个方向都正确：整个侧栏（含 portal 进来的列表）算一个整体，
  // 只有指针真正离开它的 DOM 子树才收起。
  // 悬浮收起的「淡出窗口」：离开后等宽度动画把侧栏收窄、会话槽淡出，再让槽真正 display:none。
  // 只服务于会话槽——图标那套布局两态几何已经一致，不需要等（见下面的 isCollapsed）。
  const [hoverLeaving, setHoverLeaving] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    // 进入收起的侧栏 → 延迟后展开
    const onEnter = () => {
      if (!collapsed || !hoverExpandEnabled) return
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      // 淡出途中又回来了：立刻取消淡出窗口，宽度从当前位置往回长
      if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
      setHoverLeaving(false)
      hoverTimer.current = setTimeout(() => setHoverExpanded(true), 120)
    }
    // 真正离开 → 收起（仅收起状态下的悬浮展开）
    const onLeave = () => {
      if (!collapsed) return
      if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
      if (hoverExpanded) {
        setHoverExpanded(false)
        setHoverLeaving(true)
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        // 与 .sidebar-wrapper 的 width transition（250ms）对齐
        leaveTimer.current = setTimeout(() => setHoverLeaving(false), 250)
      }
    }
    el.addEventListener('mouseenter', onEnter)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mouseenter', onEnter)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [collapsed, hoverExpandEnabled, hoverExpanded, setHoverExpanded])

  // 卸载时清掉待触发的定时器，别让它们落到已经卸掉的侧栏上
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
  }, [])

  // 「只剩图标」**立刻生效**：两态几何已经做成完全一致（见 sidebar.css 里收起宽度取 60px 的说明），
  // 布局在动画的哪一帧切换都不会让图标移动，所以不需要再靠定时器「等动画走完」。
  const isCollapsed = collapsed && !hoverExpanded
  // 会话槽不一样：它整块消失是可见的，得等淡出（.18s）走完再 display:none。
  //   · 点按钮收起：store 的 collapsing 正好覆盖那 250ms；
  //   · 悬浮收起：用上面那个 250ms 的 hoverLeaving。
  const slotSettled = isCollapsed && !collapsing && !hoverLeaving
  const isHoverExpanded = hoverExpanded

  // ── 收起态标签气泡 ──
  // 两个条件缺一不可：
  //  · !hoverExpandEnabled —— 悬浮展开还开着的话，悬停 120ms 后侧栏自己就摊开、文字直接出来，
  //    气泡只会抢在摊开前闪一下再被文字取代，是干扰不是帮助。关掉悬浮展开之后，收起态悬停
  //    没有任何别的反馈，图标旁边不写名字就只能靠猜，气泡才成立。
  //  · slotSettled —— 复用「收起/展开动画已经走完」这个既有判据（与 .slot-gone 同一个），
  //    因为气泡的坐标是**实测**导航项右缘得来的。动画进行中（250ms）实测到的是中间帧宽度，
  //    气泡会落在离图标老远的地方。动画没停就先不弹，宁可这一下不显示。
  const tipEnabled = slotSettled && !hoverExpandEnabled
  const [tip, setTip] = useState<{ label: string; left: number; top: number } | null>(null)

  // 启用条件一变（展开、或用户重新打开悬浮展开）就立刻收掉，别让气泡孤零零挂在那儿
  useEffect(() => {
    if (!tipEnabled) setTip(null)
  }, [tipEnabled])

  // 气泡位置在这里实测：NavItem 只把元素交上来。
  // 坐标用 getBoundingClientRect（视口系），气泡是 position: fixed（同为视口系），两边一致；
  // 若改成 absolute 就得再减滚动偏移，没必要。
  const makeTipHandler = (label: string) => (el: HTMLElement | null) => {
    if (!el || !tipEnabled) {
      setTip(null)
      return
    }
    const r = el.getBoundingClientRect()
    // left = 导航项右缘 + 9px：给气泡的箭头（7px 方块的一半 + 1px 描边）留出贴合距离。
    // top = 导航项垂直中心，气泡自身用 translateY(-50%) 对齐，所以这里不必减去气泡高度。
    setTip({ label, left: r.right + 9, top: r.top + r.height / 2 })
  }

  // 「对话 / 工作台」共用 agent-code 这一个 view，只有工作区模式能把它们分开
  const isActiveItem = (item: NavDef) => view === item.key && (!item.mode || agentMode === item.mode)
  const openItem = (item: NavDef) => {
    // 模式相同就别写 store：写了会白刷一轮订阅者，而切换本身是空操作
    if (item.mode && item.mode !== agentMode) {
      // 「对话 / 工作台」共用 agent-code：互切时 view 不变，App 那层收不到信号，这里补一声
      // （view 真变了就交给 App 播，免得同一次点击响两次）
      if (view === item.key) playNavSound(navKeyOf(item))
      setAgentMode(item.mode)
    }
    setView(item.key)
  }

  // 「工具箱」入口：落在任一被收纳的界面里即算激活
  const toolsActive = GROUPED_VIEWS.has(view)

  // 常驻导航项的统一渲染：NAV_ITEMS 与 NAV_TAIL_ITEMS 两段共用——「工具箱」入口夹在中间，
  // 所以清单在 navConfig 里切成两段（原因见那里的注释）。抽成函数是为了两段的样式不会各自漂移。
  // 导航栏只表达一件事：**当前在哪一页**（.nav-item.active 的填充 + 左侧竖条，见 sidebar.css）。
  // 「有模型在跑」不再点亮任何导航项——那是运行状态，不是导航状态；之前它会让好几项一起变绿，
  // 反而盖过了「当前页」这个唯一该看的信息。
  const renderNavItem = (item: NavDef) => (
    <NavItem
      key={navKeyOf(item)}
      icon={item.icon}
      label={item.label}
      active={isActiveItem(item)}
      onClick={() => openItem(item)}
      onHover={() => preloadViewOnHover(item.key)}
      onTip={makeTipHandler(item.label)}
    />
  )

  // 两个「收起」类分工不同，别合并（见 sidebar.css 顶部的说明）：
  //   collapsed = 用户选择了收起（宽度窄）。取 store 的 collapsed 原值，悬浮展开期间也带着，
  //               所以悬浮展开不会把 wrapper 撑宽、把主界面往右挤。
  //   icon-only = collapsed && !hoverExpanded，即真的只剩图标在显示，
  //               「只剩图标」那套样式挂它，悬浮展开时必须失效。
  return (
    <div
      ref={wrapperRef}
      className={`sidebar-wrapper${collapsed ? ' collapsed' : ''}${isCollapsed ? ' icon-only' : ''}${slotSettled ? ' slot-gone' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
    >
      <nav className="sidebar">
        {/* ── 导航分隔线 ──
            把折叠按钮（窗口级操作）和下面这组页面级导航分开。收起 / 展开时它只改宽度
            （展开通栏、收起 22px 居中），纵向占位两态一致，所以不会带动任何图标移动。
            纯装饰，对读屏器隐藏。见 sidebar.css 的 .nav-divider。 */}
        <div className="nav-divider" aria-hidden="true" />

        {/* ── 常驻导航项（「工具箱」入口之前）：清单与顺序见 utils/navConfig.ts 的 NAV_ITEMS ── */}
        {NAV_ITEMS.map(renderNavItem)}

        {/* ── 工具箱：低频界面统一收进这一页，页内用二级导航切换 ── */}
        <NavItem
          icon={TOOLS_ENTRY.icon}
          label={TOOLS_ENTRY.label}
          active={toolsActive}
          onClick={() => setView(resolveToolsEntryView())}
          onTip={makeTipHandler(TOOLS_ENTRY.label)}
        />

        {/* ── Agent Code 区：模式切换 + 新建 + 会话列表 ──
            模式切换（对话 / 工作台）在这里直接渲染；列表的状态与组件本体仍归 AgentCodeView，
            渲染时经 portal **追加**进这个槽位（见 agent-code/agent-view/AgentCodeViewLayout.tsx）。
            所以 DOM 顺序天然是「模式切换 → 新建聊天/新添项目 → 会话列表」，列表不需要让位，
            也不用改它的插入顺序。槽紧跟在常驻导航项之后，下面就是弹性空档 + 底部固定区。
            注：列表只在 Agent Code 视图里挂载，模式切换则任何页面都在——
            否则站在别的页面就没法切回对话 / 工作台了。 */}
        <div className="sidebar-agent-slot" id={AGENT_SESSION_SLOT_ID}>
          <div className="sidebar-mode-switch" role="group" aria-label="Agent Code 模式">
            {MODE_ITEMS.map((item) => (
              <NavItem
                key={navKeyOf(item)}
                /* 不传 icon：纯文字按钮。这两个模式的图标没有信息增量，
                   反而在收起/展开的宽度动画里最容易被看出抖动。 */
                label={item.label}
                active={isActiveItem(item)}
                onClick={() => openItem(item)}
                onHover={() => preloadViewOnHover(item.key)}
              />
            ))}
          </div>
        </div>

        {/* ── 底部固定区 ──
            弹性空档 + 「设置」。空档（flex: 1）吸掉剩余空间，把「设置」压到侧栏最底；
            内容超一屏时它收到 min-height 让位，整体照旧滚动。见 sidebar.css 的
            .sidebar-spacer / .sidebar-bottom。顺序见 navConfig 的 NAV_TAIL_ITEMS。 ── */}
        <div className="sidebar-spacer" aria-hidden="true" />
        <div className="sidebar-bottom">{NAV_TAIL_ITEMS.map(renderNavItem)}</div>
      </nav>

      {/* ── 收起态标签气泡 ──
          必须 portal 到 body：.sidebar 是 overflow: hidden，挂在里面会被裁掉；而且收起时
          轨道只有 60px，气泡根本放不下。另外 .sidebar-wrapper 带 z-index 会形成层叠上下文，
          留在内部的话气泡还会被它封顶。位置由 makeTipHandler 实测写入。 ── */}
      {tip &&
        createPortal(
          <div className="nav-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
            {tip.label}
          </div>,
          document.body
        )}
    </div>
  )
}
