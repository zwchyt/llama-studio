import React, { useCallback, useEffect, useRef, useState, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import { useSidebarStore, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH } from '../store/sidebarStore'
import { shallow } from 'zustand/shallow'
import {
  MODE_ITEMS,
  NAV_ITEMS,
  GROUPED_VIEWS,
  navKeyOf
} from '../utils/navConfig'
import type { NavDef } from '../utils/navConfig'
import { playNavSound } from '../utils/sound'
import { SettingsIcon } from '@animateicons/react/lucide'
import { AGENT_SESSION_SLOT_ID } from './agent-code/agent-session/slotId'
import { preloadViewOnHover } from '../views/viewRegistry'
import '../styles/sidebar.css'

// 导航清单收敛在 utils/navConfig.ts：NAV_ITEMS 是常驻项；「设置」入口在底部固定区
// （整屏设置中心，工具箱已并入）；「对话 / 工作台」在 MODE_ITEMS 里。本组件只负责渲染。

// 导航栏那个 Agent Code 入口的名字：固定叫「智能体」（README 对这组界面的统称），
// 不跟着模式叫「聊天 / 编码」——紧挨着下面就是那两个切换按钮，同名会让人以为有两组入口。
const AGENT_ENTRY_LABEL = '智能体'

interface NavItemProps {
  /** 图标。可省略——省略时只渲染文字。 */
  icon?: React.ElementType
  label: string
  active?: boolean
  /** 切换按钮的按下态（aria-pressed）。只有"同一个界面的两种模式"这类分段控件需要：
   *  它的选中态是纯视觉的（底色 + 形状），读屏拿不到；常驻导航项的"当前页"不吃这条，
   *  那类语义由视图本身承载，不传就是普通按钮。 */
  pressed?: boolean
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
  ({ icon: Icon, label, active, pressed, onClick, onHover, onTip, style, children, className = '' }, ref) => {
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
        aria-pressed={pressed}
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

  // ── 窄窗口自动收起 / 展开 ──
  // 用 matchMedia 而不是 resize：只在跨过阈值那一刻回调一次，拖拽窗口时不做每帧计算。
  // 与手动逻辑的分工见 store：窄屏下的点击写 narrowOverride（跨过阈值即失效），
  // 宽屏下的点击写 userCollapsed（变窄再变宽会恢复它）——所以「手动收起后拉大窗口」
  // 不会被自动展开，「窄屏手动展开」也不会被下一次 resize 立刻收回去。
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH}px)`)
    const apply = () => useSidebarStore.getState().syncAutoNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // 「只剩图标」**立刻生效**：两态几何已经做成完全一致（见 sidebar.css 里收起宽度取 60px 的说明），
  // 布局在动画的哪一帧切换都不会让图标移动，所以不需要再靠定时器「等动画走完」。
  const isCollapsed = collapsed && !hoverExpanded
  // 会话槽不一样：它整块消失是可见的，得等淡出（.18s）走完再 display:none。
  //   · 点按钮收起：store 的 collapsing 正好覆盖那 250ms；
  //   · 悬浮收起：用上面那个 250ms 的 hoverLeaving。
  const slotSettled = isCollapsed && !collapsing && !hoverLeaving
  const isHoverExpanded = hoverExpanded

  // 会话槽的入场动画（.sidebar-agent-slot>* 的 sidebar-slot-in）是给「首屏空闲时才 portal
  // 挂进来」补的过渡。但收起用的是 display:none，再展开就是重新创建盒子 → 动画每次重跑，
  // 列表在宽度动画的同时又自己滑一次，看着就是抖。这里只放行第一次显示，之后挂 .slot-entered
  // 把它关掉，展开过程只留给宽度动画去揭示。
  const slotVisible = !slotSettled
  const slotRevealsRef = useRef(0)
  const prevSlotVisibleRef = useRef(false)
  const [slotEntered, setSlotEntered] = useState(false)
  useEffect(() => {
    if (slotVisible && !prevSlotVisibleRef.current) {
      slotRevealsRef.current++
      if (slotRevealsRef.current > 1) setSlotEntered(true)
    }
    prevSlotVisibleRef.current = slotVisible
  }, [slotVisible])

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

  // 气泡只在悬停期间存在。只挂 mouseleave 会漏两种：
  //  · 点导航项时指针没动，浏览器不补发 mouseleave，切完视图气泡还挂在那儿；
  //  · 列表滚动 / 窗口缩放后 fixed 坐标失效，气泡会飘到别处。
  // 监听在挂载时注册一次即可，没有气泡时 handler 是空操作。
  useEffect(() => {
    const hide = () => setTip(p => (p ? null : p))
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('keydown', hide, true)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('keydown', hide, true)
    }
  }, [])

  // 视图 / 模式一变就收：气泡描述的是「刚才那个入口」，换页之后已经没有意义
  useEffect(() => { setTip(null) }, [view, agentMode])

  // 气泡位置在这里实测：NavItem 只把元素交上来。
  // 坐标用 getBoundingClientRect（视口系），气泡是 position: fixed（同为视口系），两边一致；
  // 若改成 absolute 就得再减滚动偏移，没必要。
  const makeTipHandler = (label: string) => (el: HTMLElement | null) => {
    if (!el || !tipEnabled) {
      setTip(null)
      return
    }
    const r = el.getBoundingClientRect()
    // left = 导航项右缘 + 5px：箭头是 7px 方块旋转 45°，尖端探出气泡约 5px，这个间距刚好
    // 让尖端贴到导航项外沿而又不压上去；再小就会露出断开的尖角。
    // top = 导航项垂直中心，气泡自身用 translateY(-50%) 对齐，所以这里不必减去气泡高度。
    setTip({ label, left: r.right + 5, top: r.top + r.height / 2 })
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

  // 「设置」入口：打开设置中心整屏；停在设置或任一工具页都算激活
  const settingsActive = view === 'settings' || GROUPED_VIEWS.has(view)

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

  // Agent Code 在导航栏上的入口：图标跟着当前模式换（聊天 / 编码），
  // hover 动画走 animateicons，与其余导航项同一套。
  const modeItem = MODE_ITEMS.find(i => i.mode === agentMode) ?? MODE_ITEMS[0]

  // 两个「收起」类分工不同，别合并（见 sidebar.css 顶部的说明）：
  //   collapsed = 用户选择了收起（宽度窄）。取 store 的 collapsed 原值，悬浮展开期间也带着，
  //               所以悬浮展开不会把 wrapper 撑宽、把主界面往右挤。
  //   icon-only = collapsed && !hoverExpanded，即真的只剩图标在显示，
  //               「只剩图标」那套样式挂它，悬浮展开时必须失效。
  return (
    <div
      ref={wrapperRef}
      className={`sidebar-wrapper${collapsed ? ' collapsed' : ''}${isCollapsed ? ' icon-only' : ''}${slotSettled ? ' slot-gone' : ''}${slotEntered ? ' slot-entered' : ''}${isHoverExpanded ? ' hover-expanded' : ''}`}
    >
      <nav className="sidebar">
        {/* ── 导航区顶端留白 ──
            分组线已按要求去掉（见 sidebar.css 的 .nav-divider），这个元素只留 10px 纵向占位，
            删掉它会让下面整列导航项上移。纯装饰，对读屏器隐藏。 */}
        <div className="nav-divider" aria-hidden="true" />

        {/* ── 常驻导航项：清单与顺序见 utils/navConfig.ts 的 NAV_ITEMS ── */}
        {NAV_ITEMS.map(renderNavItem)}

        {/* ── Agent Code 入口：名字固定「智能体」，图标跟随当前模式（聊天 / 编码）──
            紧贴下面那个会话槽放，让「入口 → 模式切换 → 会话列表」在视觉上连成一件事。
            更要紧的是：收起态会话槽整块淡出（见 .icon-only .sidebar-agent-slot），
            没有这一项就没法从导航栏进 Agent Code 了。
            激活判据用 isActiveItem（view 是 agent-code 且模式对得上）——modeItem 就是按
            当前模式挑的，所以它恒等于「正停在 Agent Code」。 */}
        <NavItem
          key={navKeyOf(modeItem)}
          icon={modeItem.icon}
          label={AGENT_ENTRY_LABEL}
          active={isActiveItem(modeItem)}
          onClick={() => openItem(modeItem)}
          onHover={() => preloadViewOnHover(modeItem.key)}
          onTip={makeTipHandler(AGENT_ENTRY_LABEL)}
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
            {MODE_ITEMS.map((item) => {
              // 模式开关反映「当前选中的模式」，与当前所在视图无关。
              // 原来用 isActiveItem（要求 view === agent-code）：站在别的页面时两个都不亮，
              // 选中胶囊停在左边像「聊天」，而下面的会话列表仍按 agentMode 显示编码，看着就不一致。
              const on = agentMode === item.mode
              return (
                <NavItem
                  key={navKeyOf(item)}
                  icon={item.icon}
                  label={item.label}
                  active={on}
                  pressed={on}
                  onClick={() => openItem(item)}
                  onHover={() => preloadViewOnHover(item.key)}
                />
              )
            })}
          </div>
        </div>

        {/* ── 底部固定区 ──
            「设置」入口：打开设置中心整屏（左栏顶部是设置页，下面是各工具页）。
            停在设置或任一工具页都算激活。 ── */}
        <div className="sidebar-spacer" aria-hidden="true" />
        <div className="sidebar-bottom">
          <NavItem
            icon={SettingsIcon}
            label="设置"
            active={settingsActive}
            onClick={() => setView('settings')}
            onHover={() => {
              // 悬停就把设置中心整屏的壳 + 设置页代码都预取掉，点击零等待
              preloadViewOnHover('settings')
              void import('../components/ToolsHub')
            }}
            onTip={makeTipHandler('设置')}
          />
        </div>
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
