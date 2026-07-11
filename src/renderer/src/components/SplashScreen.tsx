import { useEffect, useRef } from 'react'

interface SplashScreenProps {
  /** 当数据初始化完成时由父组件置为 true，触发爆炸散开退场 */
  startExit: boolean
  /** 退场动画播放完毕后回调，父组件据此卸载本组件 */
  onExited: () => void
}

/**
 * 开屏动画：基于斐波那契球粒子 + 水波起伏 + 鼠标交互 + 点击冲击波 + 爆炸退场。
 * 作为 React 组件渲染（参考 hexllama 的 loading 开屏逻辑），由父组件的
 * loading 状态驱动显示/退场，不依赖任何全局函数和 index.html 内联脚本。
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
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = W * DPR
      canvas.height = H * DPR
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      cx = W / 2
      cy = H / 2
      R = Math.min(W, H) * 0.32
    }
    resize()
    window.addEventListener('resize', resize)

    // —— 鼠标交互：光标附近的点被推开打乱，移出后平滑复原 ——
    let mx = -9999, my = -9999, mxT = -9999, myT = -9999, mPow = 0, mTar = 0
    window.addEventListener('mousemove', e => { mxT = e.clientX; myT = e.clientY; mTar = 1 })
    window.addEventListener('mouseout', e => { if (!e.relatedTarget) mTar = 0 })
    window.addEventListener('blur', () => { mTar = 0 })

    // —— 拖拽旋转：按住拖动手动转球，松手平滑回归自动旋转（触屏同样可用） ——
    let dragging = false, lastX = 0, lastY = 0, dragDist = 0
    let rotY = 0, rotX = 0.35, prevTime = 0
    window.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; dragDist = 0 })
    window.addEventListener('pointermove', e => {
      if (!dragging) return
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      dragDist += Math.hypot(dx, dy)
      rotY += dx * 0.008
      rotX += dy * 0.008
      if (rotX < -1.2) rotX = -1.2
      if (rotX > 1.2) rotX = 1.2
    })
    window.addEventListener('pointerup', () => { dragging = false })
    window.addEventListener('pointercancel', () => { dragging = false })

    // —— 点击触发冲击波 ——
    const shocks: { x: number; y: number; t0: number; age: number; radius: number; life: number }[] = []
    window.addEventListener('click', e => {
      if (dragDist > 6) return
      shocks.push({ x: e.clientX, y: e.clientY, t0: performance.now(), age: 0, radius: 0, life: 0 })
    })

    // —— 退场控制 ——
    let stopped = false
    let running = true, hiddenAt = 0, rafId = 0
    let exiting = false, exitStartAbs = 0
    const BURST = 1.4
    const fallbackTimer = window.setTimeout(() => { if (!exiting) { exiting = true; exitStartAbs = performance.now() } }, 15000)

    document.addEventListener('visibilitychange', () => {
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
    })

    // —— 斐波那契球均匀生成黑色点 ——
    const N = 2200
    const golden = Math.PI * (3 - Math.sqrt(5))
    const pts: { x: number; y: number; z: number; lat: number; lon: number; jit: number; burst: number; burst2: number }[] = []
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const t = i * golden
      pts.push({
        x: Math.cos(t) * r, y, z: Math.sin(t) * r,
        lat: Math.asin(y),
        lon: Math.atan2(Math.sin(t) * r, Math.cos(t) * r),
        jit: Math.random() * Math.PI * 2,
        burst: Math.random(),
        burst2: Math.random()
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
      const time = (now - start) / 1000
      ctx!.clearRect(0, 0, W, H)

      // 父组件通知退场时启动爆炸
      if (startExitRef.current && !exiting) { exiting = true; exitStartAbs = performance.now() }

      mPow += (mTar - mPow) * 0.08
      mx += (mxT - mx) * 0.2
      my += (myT - my) * 0.2

      const dt = Math.min(0.05, time - prevTime)
      prevTime = time
      if (!dragging) {
        rotY += 0.5 * dt
        const target = 0.35 + Math.sin(time * 0.3) * 0.12
        rotX += (target - rotX) * 0.04
      }

      const ay = rotY
      const ax = rotX
      const exitProg = exiting ? ((now - exitStartAbs) / 1000) / BURST : 0

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
        alpha *= holeFade
        if (alpha <= 0.004) continue

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

        if (mPow > 0.002) {
          const dx = sx - mx, dy = sy - my
          const dist = Math.hypot(dx, dy)
          const Rinf = 120
          if (dist < Rinf) {
            const f = 1 - dist / Rinf
            const push = f * f * 70 * mPow
            const a2 = Math.atan2(dy, dx) + Math.sin(p.jit + time * 2) * 0.7
            sx += Math.cos(a2) * push
            sy += Math.sin(a2) * push
          }
        }

        for (let s = 0; s < shocks.length; s++) {
          const sh = shocks[s]
          const dx = sx - sh.x, dy = sy - sh.y
          const dd = Math.hypot(dx, dy)
          const off = Math.abs(dd - sh.radius)
          const band = 36
          if (off < band) {
            const f = 1 - off / band
            const push = f * 58 * sh.life
            const a = Math.atan2(dy, dx)
            sx += Math.cos(a) * push
            sy += Math.sin(a) * push
          }
        }

        if (exitProg > 0) {
          const e = Math.min(1, exitProg)
          const ease = 1 - Math.pow(1 - e, 2)
          const ang = Math.atan2(sy - cy, sx - cx) + (p.burst2 - 0.5) * 0.7
          const burst = (160 + p.burst * 320) * ease
          sx += Math.cos(ang) * burst
          sy += Math.sin(ang) * burst
          alpha *= (1 - e)
        }

        ctx!.beginPath()
        ctx!.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (alpha * intro).toFixed(3) + ')'
        ctx!.arc(sx, sy, Math.max(0.25, size), 0, Math.PI * 2)
        ctx!.fill()
      }

      if (exiting && exitProg >= 1) {
        stopped = true
        onExitedRef.current()
      }

      if (running && !stopped) rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(fallbackTimer)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div id="splash-screen">
      <canvas ref={canvasRef} id="splash-canvas" />
    </div>
  )
}
