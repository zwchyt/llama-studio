import { useEffect, useRef } from 'react'

interface SplashScreenProps {
  /** 当数据初始化完成时由父组件置为 true，触发爆炸散开退场 */
  startExit: boolean
  /** 退场动画播放完毕后回调，父组件据此卸载本组件 */
  onExited: () => void
}

/**
 * 开屏动画：基于斐波那契球粒子 + 水波起伏 + 鼠标交互 + 点击冲击波 + 退场（积木塔重力散落崩落）。
 * 统一时间线流程：开场球体 -> 短暂展示后自动聚成 LLAMA STUDIO 文字 logo ->
 * logo 停留数秒 -> 积木塔崩落退场（圆点从底部错落失去支撑，各自不规则坠落、落地化尘）。
 * 文字成形时冻结自转、并用 settle 阻尼抑制冲击波扰动。
 * 作为 React 组件渲染，由父组件的 loading 状态驱动显示/退场。
 */
export default function SplashScreen({ startExit, onExited }: SplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startExitRef = useRef(startExit)
  const onExitedRef = useRef(onExited)
  startExitRef.current = startExit
  onExitedRef.current = onExited

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0, H = 0, cx = 0, cy = 0, R = 0, DPR = 1

    // —— 点击切换「球体 ⇄ 文字 Logo」——
    // N 个点同时服务于球体与文字 logo，文字目标点在 resize 时按当前屏幕尺寸重建
    const N = 2200
    const LOGO_TEXT = 'LLAMA-STUDIO'
    const LOGO_SIZE = 1.5
    const off = document.createElement('canvas')
    const octx = off.getContext('2d')!
    const logoTargets: { x: number; y: number }[] = new Array(N)
    let logoMode = false, logoProg = 0
    let logoFormedAt = 0            // logo 完全成形时刻，用于退场前的最短展示

    // —— 积木塔(散落版)退场所需的逐粒子状态（在 buildLogo 中初始化）——
    const tRelease: number[] = new Array(N)   // 每个圆点开始脱落(释放)的时刻(s，自退场起算)
    const tDust: number[] = new Array(N)      // 落地后水平飘散速度(px/s)，营造灰尘感
    const tLand: number[] = new Array(N)      // 落地时刻(s)；-1 表示尚未落地
    const tLandX: number[] = new Array(N)     // 落地瞬间的水平坐标(NaN=未落地)，用于落地后轻微飘移
    const tX0: number[] = new Array(N)        // 脱落瞬间冻结的水平坐标(保证无缝衔接)
    const tY0: number[] = new Array(N)        // 脱落瞬间冻结的竖直坐标(作为下落起点)
    const tG: number[] = new Array(N)         // 每个圆点各自的"重力"(px/s²)，造成下落快慢不一
    const tVX: number[] = new Array(N)        // 水平速度(px/s)，使圆点斜向飞散而非整齐垂落
    const tVY0: number[] = new Array(N)      // 初始竖直速度(px/s)，制造向上微弹/迟滞的碎屑感
    const tGlint: number[] = new Array(N)     // 高光点方向(弧度)，逐个随机→不规则翻滚的亮点
    const TOWER_CASCADE = 0.55      // 从底到顶"失去支撑"的总时长(s)：底层先脱落、上层随后，但不整齐
    const TOWER_DUST_FADE = 0.5     // 落地后像灰尘淡出的时长(s)
    const TOWER_BODY: [number, number, number] = [78, 88, 116]  // 空中圆点主体色(带高光)
    // logo 粒子：偏移 + 偏移速度
    const lOX = new Float64Array(N)
    const lOY = new Float64Array(N)
    const logoOVx = new Float64Array(N)   // 偏移速度
    const logoOVy = new Float64Array(N)
    const DAMP = 0.84               // 速度阻尼

    // 自由落体退出：记录粒子当前位置作为下落起点
    const fallX = new Float64Array(N)
    const fallY = new Float64Array(N)

    // —— 羊驼形状目标点（相对鼠标位置）——
    const llamaTargets: { x: number; y: number }[] = new Array(N)
    let llamaProg = 0                     // 0=logo 1=🦙
    const LLAMA_COLOR_R = 196, LLAMA_COLOR_G = 178, LLAMA_COLOR_B = 150  // 暖棕色
    const LLAMA_SIZE_MULT = 2.2           // 羊驼粒子略大
    let logoBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 }

    // 采样羊驼 emoji 为相对坐标
    function buildLlamaShape() {
      const ccx = W / 2, ccy = H / 2
      const size = Math.min(W, H) * 0.50
      octx.clearRect(0, 0, W, H)
      octx.textAlign = 'center'
      octx.textBaseline = 'middle'
      octx.font = size + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'
      octx.fillStyle = '#fff'
      octx.fillText('🦙', ccx, ccy)
      const data = octx.getImageData(0, 0, W, H).data
      const samp: { x: number; y: number }[] = []
      let step = 3
      for (let attempt = 0; attempt < 6; attempt++) {
        samp.length = 0
        for (let y = 0; y < H; y += step) {
          for (let x = 0; x < W; x += step) {
            if (data[(y * W + x) * 4 + 3] > 128) samp.push({ x: x - ccx, y: y - ccy })
          }
        }
        if (samp.length >= N) break
        step = Math.max(2, step - 1)
      }
      for (let i = samp.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = samp[i]; samp[i] = samp[j]; samp[j] = t
      }
      for (let i = 0; i < N; i++) {
        llamaTargets[i] = samp.length ? samp[i % samp.length] : { x: 0, y: 0 }
      }
    }

    // 将 LOGO_TEXT 栅格化，按像素采样为 N 个目标点（自适应步长，尽量接近 N）
    function buildLogo() {
      off.width = W; off.height = H
      let fontSize = Math.floor(Math.min(H * 0.20, (W * 0.86) / (LOGO_TEXT.length * 0.62)))
      octx.clearRect(0, 0, W, H)
      octx.fillStyle = '#fff'
      octx.textAlign = 'center'
      octx.textBaseline = 'middle'
      octx.font = 'bold ' + fontSize + 'px Arial, sans-serif'
      const tw = octx.measureText(LOGO_TEXT).width
      const maxW = W * 0.86
      if (tw > maxW) {
        fontSize = Math.floor(fontSize * maxW / tw)
        octx.font = 'bold ' + fontSize + 'px Arial, sans-serif'
      }
      octx.fillText(LOGO_TEXT, W / 2, H / 2)
      const data = octx.getImageData(0, 0, W, H).data
      const samp: { x: number; y: number }[] = []
      let step = 5
      for (let attempt = 0; attempt < 6; attempt++) {
        samp.length = 0
        for (let y = 0; y < H; y += step) {
          for (let x = 0; x < W; x += step) {
            if (data[(y * W + x) * 4 + 3] > 128) samp.push({ x, y })
          }
        }
        if (samp.length >= N) break
        step = Math.max(2, step - 1)
      }
      for (let i = samp.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = samp[i]; samp[i] = samp[j]; samp[j] = t
      }
      for (let i = 0; i < N; i++) {
        logoTargets[i] = samp.length ? samp[i % samp.length] : { x: cx, y: cy }
      }
      // 计算 logo 包围盒
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let i = 0; i < N; i++) {
        const t = logoTargets[i]
        if (t.x < minX) minX = t.x
        if (t.x > maxX) maxX = t.x
        if (t.y < minY) minY = t.y
        if (t.y > maxY) maxY = t.y
      }
      logoBounds = { minX, maxX, minY, maxY }
      // —— 积木塔(散落版)：按垂直高度从底向上"逐点"失去支撑，每个圆点以各自不规则的轨迹坠落 ——
      let tyMin = Infinity, tyMax = -Infinity
      for (let i = 0; i < N; i++) { const y = logoTargets[i].y; if (y < tyMin) tyMin = y; if (y > tyMax) tyMax = y }
      const tspan = Math.max(1, tyMax - tyMin)
      for (let i = 0; i < N; i++) {
        const frac = (tyMax - logoTargets[i].y) / tspan   // 0=最底排 1=最顶排
        // 底层先脱落、上层略晚，但叠加随机抖动→不再是整齐的水平层，而是错落崩落
        tRelease[i] = Math.max(0, frac * TOWER_CASCADE + (Math.random() - 0.5) * 0.36)
        tG[i] = 2800 + Math.random() * 1400               // 重力各异：有快有慢
        tVX[i] = (Math.random() * 2 - 1) * 55             // 水平飞散
        tVY0[i] = (Math.random() * 2 - 1) * 30            // 初始竖直随机(微弹/迟滞)
        tGlint[i] = Math.random() * Math.PI * 2           // 高光方向随机
        tDust[i] = (Math.random() * 2 - 1) * 18
        tLand[i] = -1
        tLandX[i] = NaN
        tX0[i] = NaN
        tY0[i] = NaN
      }
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth
      H = window.innerHeight
      canvas!.width = W * DPR
      canvas!.height = H * DPR
      canvas!.style.width = W + 'px'
      canvas!.style.height = H + 'px'
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0)
      cx = W / 2
      cy = H / 2
      R = Math.min(W, H) * 0.32
      buildLogo()                     // 屏幕尺寸变化时重建 logo 目标点
      buildLlamaShape()               // 重建羊驼形状采样
    }
    resize()
    window.addEventListener('resize', resize)

    // —— 鼠标交互：追踪光标位置（用于 logo 粒子吸附） + 拖拽旋转球体 ——
    let mx = -9999, my = -9999, mxT = -9999, myT = -9999, mPow = 0, mTar = 0
    const onMouseMove = (e: MouseEvent) => { mxT = e.clientX; myT = e.clientY; mTar = 1 }
    const onMouseOut = (e: MouseEvent) => { if (!e.relatedTarget) mTar = 0 }
    const onBlur = () => { mTar = 0 }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseout', onMouseOut)
    window.addEventListener('blur', onBlur)

    // —— 拖拽旋转：按住拖动手动转球，松手平滑回归自动旋转（触屏同样可用） ——
    let dragging = false, lastX = 0, lastY = 0, dragDist = 0
    let rotY = 0, rotX = 0.35, prevTime = 0
    const onPointerDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; dragDist = 0 }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      dragDist += Math.hypot(dx, dy)
      rotY += dx * 0.008
      rotX += dy * 0.008
      if (rotX < -1.2) rotX = -1.2
      if (rotX > 1.2) rotX = 1.2
    }
    const onPointerUp = () => { dragging = false }
    const onPointerCancel = () => { dragging = false }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)

    // —— 点击触发冲击波 ——
    const shocks: { x: number; y: number; t0: number; age: number; radius: number; life: number }[] = []
    const onClick = (e: MouseEvent) => {
      if (dragDist > 6) return
      shocks.push({ x: e.clientX, y: e.clientY, t0: performance.now(), age: 0, radius: 0, life: 0 })
    }
    window.addEventListener('click', onClick)

    // —— 退场控制 ——
    let stopped = false
    let running = true, hiddenAt = 0, rafId = 0
    let exiting = false, exitStartAbs = 0
    const BURST = 2.0               // 退场(积木塔崩落)总时长(s)，调大=更慢更柔
    // 退场淡出：粒子炸开到这一进度后，让整个开屏层一起 opacity 渐隐，
    // 与主界面交叉淡入，消除"静态背景→突现主界面"的硬切跳屏。
    // 淡出与粒子爆炸后半段重叠，不额外拖长总时长。
    const FADE_START = 0.6
    const LOGO_HOLD_MS = 1200       // logo 成形后的最短展示时长，避免"刚成形就炸开"看不见
    const LOGO_DELAY_MS = 900       // 开场球体展示多久后自动聚成 logo（无需点击）
    const LOGO_SPEED = 1.2          // logo 重组速度(/s)，基于 dt 帧率无关，约 3s 成形
    const rootEl = canvas.parentElement as HTMLElement | null

    // 两个后备定时器互相配合：
    // - fallbackExitTimer: 启动退场动画（如果尚未启动），15s 后触发
    // - fallbackForceTimer: 直接强制完成退场，防止动画循环异常停止后永远卡住，18s 后触发
    const fallbackExitTimer = window.setTimeout(() => {
      if (!exiting) { exiting = true; exitStartAbs = performance.now() }
    }, 15000)
    const fallbackForceTimer = window.setTimeout(() => {
      if (!stopped) { stopped = true; onExitedRef.current() }
    }, 20000)

    const onVisibilityChange = () => {
      if (document.hidden) {
        running = false
        hiddenAt = performance.now()
        cancelAnimationFrame(rafId)
      } else if (!running && !stopped) {
        running = true
        const paused = performance.now() - hiddenAt
        start += paused
        exitStartAbs += paused
        prevTime = (performance.now() - start) / 1000
        rafId = requestAnimationFrame(frame)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // —— 斐波那契球均匀生成黑色点 ——
    const golden = Math.PI * (3 - Math.sqrt(5))
    const pts: { x: number; y: number; z: number; lat: number; lon: number; jit: number }[] = []
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const t = i * golden
      pts.push({
        x: Math.cos(t) * r, y, z: Math.sin(t) * r,
        lat: Math.asin(y),
        lon: Math.atan2(Math.sin(t) * r, Math.cos(t) * r),
        jit: Math.random() * Math.PI * 2
      })
    }

    const holes = [
      { lon: 0.6, lat: 0.3, speed: 0.45, phase: 0.0, maxR: 0.55 },
      { lon: 3.4, lat: -0.6, speed: 0.32, phase: 2.1, maxR: 0.48 }
    ]

    const FOCAL = 3.0
    let start = performance.now()

    const _L = Math.hypot(0.6, 0.5, 0.5)
    const lx = -0.6 / _L, ly = -0.5 / _L, lz = 0.5 / _L

    function rot(p: { x: number; y: number; z: number }, ax: number, ay: number) {
      let y = p.y * Math.cos(ax) - p.z * Math.sin(ax)
      let z = p.y * Math.sin(ax) + p.z * Math.cos(ax)
      let x = p.x
      let x2 = x * Math.cos(ay) + z * Math.sin(ay)
      let z2 = -x * Math.sin(ay) + z * Math.cos(ay)
      return { x: x2, y, z: z2 }
    }

    function frame(now: number) {
      try {
      const time = (now - start) / 1000
      ctx!.clearRect(0, 0, W, H)

      // 自动流程：开场短暂展示球体后，自动聚成 logo（无需点击）
      if (performance.now() - start >= LOGO_DELAY_MS) logoMode = true

      // —— 退场调度（统一时间线）——
      // 固定流程：球体 -> (LOGO_DELAY_MS) -> 聚成 logo -> 停留 LOGO_HOLD_MS -> 优雅退场。
      // 退场在数据就绪(startExit)且 logo 已成形并保持足够久后才开始，保证 logo 一定被看到；
      // 若数据尚未就绪，logo 会一直展示，不会提前退场。
      const logoFormed = logoMode && logoProg >= 0.99
      const logoStillForming = logoMode && logoProg < 0.99
      const holdEnough = logoFormed && logoFormedAt !== 0 && performance.now() - logoFormedAt >= LOGO_HOLD_MS
      if (startExitRef.current && !exiting && !logoStillForming && holdEnough) {
        exiting = true
        exitStartAbs = performance.now()
      }

      const dt = Math.min(0.05, time - prevTime)
      prevTime = time

      // 鼠标位置平滑过渡：移出窗口后 mPow 逐渐归零 -> 粒子归位
      mPow += (mTar - mPow) * 0.08
      mx += (mxT - mx) * 0.2
      my += (myT - my) * 0.2

      if (!dragging && !logoMode) {       // 文字成形时冻结自转，保持清晰
        rotY += 0.5 * dt
        const target = 0.35 + Math.sin(time * 0.3) * 0.12
        rotX += (target - rotX) * 0.04
      }

      const ay = rotY
      const ax = rotX

      // 重组进度（球体 0 ⇄ 文字 1，smoothstep 平滑过渡），使用 dt 保证帧率无关
      const logoTarget = logoMode ? 1 : 0
      const progRemaining = logoTarget - logoProg
      if (progRemaining > 0.001) {
        logoProg += progRemaining * LOGO_SPEED * Math.min(dt, 0.1)
      } else if (progRemaining < -0.001) {
        logoProg += progRemaining * LOGO_SPEED * Math.min(dt, 0.1)
      } else {
        logoProg = logoTarget
      }
      if (logoProg > 1) logoProg = 1
      if (logoProg < 0) logoProg = 0
      // 记录 logo 完成成形的时刻，用于退场前的最短展示
      if (logoMode && logoProg >= 0.99) {
        if (logoFormedAt === 0) logoFormedAt = performance.now()
      } else {
        logoFormedAt = 0
      }
      const mRaw = logoProg < 0 ? 0 : logoProg > 1 ? 1 : logoProg
      const mEase = mRaw * mRaw * (3 - 2 * mRaw)

      // —— 羊驼模式检测 ——
      // 鼠标靠近 logo 包围盒（外扩 150px）才激活，激活后拉取半径 R=300 保证羊驼完整
      const mouseNearLogo = mx >= logoBounds.minX - 150 && mx <= logoBounds.maxX + 150 &&
                            my >= logoBounds.minY - 150 && my <= logoBounds.maxY + 150
      const llamaActive = logoMode && mPow > 0.05 && mouseNearLogo && !exiting
      const llamaTarget = exiting ? llamaProg : (llamaActive ? 1 : 0) // 退出时冻结当前位置
      llamaProg += (llamaTarget - llamaProg) * 1.2 * Math.min(dt, 0.1)
      if (llamaProg > 1) llamaProg = 1
      if (llamaProg < 0) llamaProg = 0
      const llamaEase = llamaProg * llamaProg * (3 - 2 * llamaProg) // smoothstep

      const exitProg = exiting ? ((now - exitStartAbs) / 1000) / BURST : 0

      // 退场后半段：整层淡出，平滑露出背后已渲染好的主界面
      if (exiting && rootEl) {
        const fade = Math.min(1, Math.max(0, (exitProg - FADE_START) / (1 - FADE_START)))
        rootEl.style.opacity = String(1 - fade)
      }

      const holeDirs = holes.map(h => {
        const lon = h.lon + time * h.speed
        const lat = h.lat + Math.sin(time * 0.4 + h.phase) * 0.25
        return {
          x: Math.cos(lat) * Math.cos(lon),
          y: Math.sin(lat),
          z: Math.cos(lat) * Math.sin(lon),
          rad: h.maxR * Math.max(0, Math.sin(time * 0.9 + h.phase))
        }
      })

      const intro = Math.min(1, time / 0.6)

      for (let k = shocks.length - 1; k >= 0; k--) {
        const s = shocks[k]
        s.age = (now - s.t0) / 1000
        s.radius = s.age * 520
        s.life = Math.max(0, 1 - s.age / 1.6)
        if (s.life <= 0) shocks.splice(k, 1)
      }

      for (let i = 0; i < N; i++) {
        const p = pts[i]
        const wave =
            Math.sin(p.lat * 3.5 + time * 1.7) * 0.5
          + Math.sin(p.lon * 2.6 - time * 1.2) * 0.5
          + Math.sin((p.lat + p.lon) * 4.2 + time * 2.3) * 0.3
        const wn = wave / 1.3
        const disp = wn * 0.12
        const pd = { x: p.x * (1 + disp), y: p.y * (1 + disp), z: p.z * (1 + disp) }
        const q = rot(pd, ax, ay)
        const scale = FOCAL / (FOCAL - q.z)
        let sx = cx + q.x * R * scale
        let sy = cy + q.y * R * scale
        const depth = (q.z + 1) / 2
        let size = (0.3 + depth * 0.7) * (1 + 0.3 * wn)
        let alpha = 0.25 + depth * 0.5

        const edge = 0.18
        let holeFade = 1
        for (const h of holeDirs) {
          if (h.rad <= 0) continue
          const d = q.x * h.x + q.y * h.y + q.z * h.z
          const ang = Math.acos(Math.max(-1, Math.min(1, d)))
          if (ang < h.rad - edge) { holeFade = 0; break }
          if (ang < h.rad) {
            const f = (ang - (h.rad - edge)) / edge
            if (f < holeFade) holeFade = f
          }
        }
        // 球体空洞遮挡效果（仅球体模式生效，logo 模式下不跳过粒子，保证文字完整）
        if (mEase <= 0.001) {
          alpha *= holeFade
          if (alpha <= 0.004) continue
        }

        const crest = Math.max(0, wn)
        let cr = Math.round(96 + (175 - 96) * crest * 0.85)
        let cg = Math.round(104 + (190 - 104) * crest * 0.85)
        let cb = Math.round(122 + (210 - 122) * crest * 0.85)
        size *= 1 + 0.45 * crest
        alpha = Math.min(1, alpha + 0.2 * crest)

        const nlen = Math.hypot(q.x, q.y, q.z) || 1
        const nl = (q.x * lx + q.y * ly + q.z * lz) / nlen
        const light = Math.max(0, nl)
        const shade = 0.28 + 0.72 * light
        cr = Math.round(cr * shade)
        cg = Math.round(cg * shade)
        cb = Math.round(cb * shade)

        // 点击重组：点飞向文字目标（颜色过渡到参考的深蓝色 RGB(45,74,138)，仅位置/大小/透明度过渡）
        // Logo 过渡（退出时跳过，保持当前位置）
        if (mEase > 0.001 && !exiting) {
          const tg = logoTargets[i]
          sx += (tg.x - sx) * mEase
          sy += (tg.y - sy) * mEase
          size += (LOGO_SIZE - size) * mEase
          alpha = Math.max(alpha, mEase)   // 文字需足够不透明才清晰
          // 从球体动态颜色平滑过渡到黑色
          cr = Math.round(cr + (35 - cr) * mEase)
          cg = Math.round(cg + (35 - cg) * mEase)
          cb = Math.round(cb + (40 - cb) * mEase)
        }

        // —— 羊驼模式（退出时冻结不动） ——
        if (logoMode && !exiting && llamaEase > 0.001) {
          const mdist = Math.hypot(mx - sx, my - sy)
          const R = 280 // 影响半径
          if (mdist < R) {
            // 四次方平滑衰减：边界处平滑归零，看不到圆圈但远处粒子完全不受影响
            const t = mdist / R
            const influence = llamaEase * (1 - t * t) * (1 - t * t)
            const lt = llamaTargets[i]
            const targetX = mx + lt.x
            const targetY = my + lt.y
            sx += (targetX - sx) * influence
            sy += (targetY - sy) * influence
            size += (LLAMA_SIZE_MULT - size) * influence
            alpha = Math.max(alpha, influence)
            // 颜色过渡到暖棕色
            cr = Math.round(cr + (LLAMA_COLOR_R - cr) * influence)
            cg = Math.round(cg + (LLAMA_COLOR_G - cg) * influence)
            cb = Math.round(cb + (LLAMA_COLOR_B - cb) * influence)
          }
        }

        // 锚点弹簧(归位) + 阻尼 + 积分
        logoOVx[i] += (0 - lOX[i]) * 90 * dt
        logoOVy[i] += (0 - lOY[i]) * 90 * dt
        logoOVx[i] *= DAMP
        logoOVy[i] *= DAMP
        lOX[i] += logoOVx[i] * dt
        lOY[i] += logoOVy[i] * dt
        sx += lOX[i]
        sy += lOY[i]

        for (let s = 0; s < shocks.length; s++) {
          const sh = shocks[s]
          const dx = sx - sh.x, dy = sy - sh.y
          const dd = Math.hypot(dx, dy)
          const off = Math.abs(dd - sh.radius)
          const band = 50
          if (off < band) {
            const f = 1 - off / band
            // logo 成形后脉冲略减但仍有明显效果
            const pulseStrength = logoMode ? 35 : 58
            const push = f * pulseStrength * sh.life
            const a = Math.atan2(dy, dx)
            sx += Math.cos(a) * push
            sy += Math.sin(a) * push
	        }
	      }

	      // ============ 退场：粒子从当前位置（logo/羊驼）塔崩散落 ============
	      if (exiting) {
	        // 使用上一帧保存的最终位置（不是本帧的球体重算位置）
	        if (Number.isNaN(tX0[i])) { tX0[i] = fallX[i]; tY0[i] = fallY[i] }
	        const te = (now - exitStartAbs) / 1000
	        if (te >= tRelease[i]) {
	          const ft = te - tRelease[i]
	          const drawX = tX0[i] + tVX[i] * ft
	          const y = tY0[i] + tVY0[i] * ft + 0.5 * tG[i] * ft * ft
	          const gy = H - size
	          if (y >= gy) {
	            if (tLand[i] < 0) { tLand[i] = te; tLandX[i] = drawX }
	            const la = te - tLand[i]
	            const fade = Math.max(0, 1 - la / TOWER_DUST_FADE)
	            const dx = tLandX[i] + tDust[i] * la
	            const dc = 38 + Math.round(20 * fade)
	            ctx!.fillStyle = 'rgba(' + dc + ',' + dc + ',' + (dc + 6) + ',' + (fade * 0.8).toFixed(3) + ')'
	            ctx!.beginPath(); ctx!.arc(dx, gy, Math.max(0.4, size), 0, Math.PI * 2); ctx!.fill()
	          } else {
	            ctx!.fillStyle = 'rgba(' + TOWER_BODY[0] + ',' + TOWER_BODY[1] + ',' + TOWER_BODY[2] + ',0.97)'
	            ctx!.beginPath(); ctx!.arc(drawX, y, Math.max(0.4, size), 0, Math.PI * 2); ctx!.fill()
	            const ga = tGlint[i]
	            ctx!.fillStyle = 'rgba(236,242,255,0.9)'
	            ctx!.beginPath(); ctx!.arc(drawX + Math.cos(ga) * size * 0.3, y + Math.sin(ga) * size * 0.3, Math.max(0.22, size * 0.4), 0, Math.PI * 2); ctx!.fill()
	          }
	          continue
	        }
	        // 未到脱落时间：用上一帧保存的最终位置（不是球体位置）
	        sx = fallX[i]
	        sy = fallY[i]
	      }

	      // 正常绘制（非退出 或 未到脱落时间）
	      ctx!.beginPath()
	      ctx!.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (alpha * intro).toFixed(3) + ')'
	      ctx!.arc(sx, sy, Math.max(0.25, size), 0, Math.PI * 2)
	      ctx!.fill()
	      // 保存当前帧最终位置，供退出时使用
	      fallX[i] = sx
	      fallY[i] = sy
	    }

	    if (exiting && exitProg >= 1) {
		      onExitedRef.current()
		    }

	    if (running && !stopped) rafId = requestAnimationFrame(frame)
      } catch (e) {
        console.error('[SplashScreen] frame error:', e)
        // 异常后继续尝试下一帧，防止动画循环意外停止导致界面卡死
        if (!stopped) rafId = requestAnimationFrame(frame)
      }
    }
    rafId = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(fallbackExitTimer)
      clearTimeout(fallbackForceTimer)
      // 清理所有事件监听，释放闭包对 TypedArray 的引用
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseout', onMouseOut)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('click', onClick)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      // 释放 offscreen canvas 的 GPU 资源
      off.width = 0
      off.height = 0
    }
  }, [])

  return (
    <div id="splash-screen">
      <canvas ref={canvasRef} id="splash-canvas" />
    </div>
  )
}
