import { createUISFX, packNames, type CueName, type PackName } from 'uisfx'
import { useStore } from '../store/useStore'

const DEFAULT_PACK: PackName = 'minimal'

/**
 * 音效引擎用 uisfx：它的运行时是纯合成 —— 每个音效在库里存成一张乐谱（音高、音符时值、
 * 噪声、瞬态），播放时才在 JS 里渲染成 AudioBuffer。所以 npm 包里那 13MB 音频素材本项目
 * 一个都不会加载（已在 electron-builder.yml 排除），也就没有 CSP media-src、临时文件、
 * 资源路径这类问题。音量沿用库里各事件音的默认值（0.2~0.24），与旧自搓音色的峰值增益相当。
 *
 * 刻意不传 preferences：传了 uisfx 会自己往 localStorage 写一份 pack/音量/开关偏好，
 * 和本项目「localStorage + 主进程 settings.json」双写机制形成两份真值。
 */
const player = createUISFX({ pack: DEFAULT_PACK })

/** 设置值可能是旧版本残留（如 'chime'）或手改的非法值，统一回落到默认音色包 */
function resolvePack(value: string | undefined): PackName {
  return value && packNames.includes(value as PackName) ? (value as PackName) : DEFAULT_PACK
}

/**
 * 事件音统一入口：总开关和音色包都在这里读 store，调用点只给事件名。
 * 事件名就是 uisfx 的语义音效：success（操作成功）、error（失败）、complete（多步流程结束）、
 * notification（有新消息）、mention（在等你回答）等。
 */
export function playEvent(cue: CueName, volume?: number): void {
  const st = useStore.getState()
  if (!st.soundEnabled) return
  try {
    player.setPack(resolvePack(st.notificationSound))
    player.play(cue, volume === undefined ? undefined : { volume })
  } catch (e) { console.warn('Event sound failed:', e) }
}

/** 试听：设置页点音色包时，用它实际会发出的「完成」音 */
export function previewSound(packId: string): void {
  try {
    player.setPack(resolvePack(packId))
    player.play('complete')
  } catch (e) { console.warn('Preview sound failed:', e) }
}

/**
 * 在用户手势中解锁音频（发送/试听等按钮点击时调用）：
 * Chromium 自动播放策略禁止在无手势的异步回调里创建/恢复 AudioContext，
 * 而事件音发生在 await 之后，必须先在手势内激活，否则永不发声
 */
export function warmUpAudio(): void {
  try { void player.unlock().catch(() => {}) } catch { /* 音频不可用时忽略 */ }
}

/**
 * 导航切换音：每一屏给一个不同的音效，闭眼听得出切到了哪一页。
 * 键是 store 里的 view 名，值用 uisfx 的语义音效（音色仍跟随设置里选的音色包）。
 * 表外的视图（新增页面等）回落到 press。
 */
const NAV_CUES: Record<string, CueName> = {
  welcome: 'wake',                  // 启动页
  cards: 'select',                  // 我的模板
  models: 'open',                   // 模型
  hub: 'expand',                    // 模型中心
  llama: 'connect',                 // Web 界面
  monitoring: 'progress-step',      // 模型运行数据
  benchmark: 'checkpoint',          // 性能测试
  'token-stats': 'streak',          // Token 统计
  ocr: 'snap',                      // OCR
  'model-tools': 'reorder',         // 模型工具
  knowledge: 'paste',               // 知识库
  tts: 'play',                      // 语音合成
  // 语音转写：全表唯一带摩擦质感的一条，跟其他页面一耳朵能分开。
  // 原先用 typing（单次键击：0.045 秒、峰值只有别人的三分之一），切过去基本听不见；
  // 换 receive 又太轻（实测峰值 0.24，其他都是 0.42）。
  stt: 'swipe',
  imagegen: 'reward',               // 图像生成
  audiocpp: 'skip-next',            // 音频工作室
  'mermaid-test': 'double-click',
  'recharts-test': 'volume-change',
  'svg-test': 'seek',
  'agent-code': 'start',            // Agent Code 工作台
  agents: 'notification',           // AI Agent
  engines: 'toggle-on',             // 后端与引擎
  folders: 'unlock',                // 模型文件夹
  settings: 'focus',                // 设置
  about: 'info',                    // 关于
}

/**
 * 切换视图时的音效，按页面各给一种。
 * 统一按 0.2 响度播：库里各音效的默认音量差很大（0.065~0.22），照默认值播会出现
 * 「切到某些页面几乎听不见」的情况，导航音要响度一致、只靠音色区分页面。
 */
export function playNavSound(view: string): void {
  playEvent(NAV_CUES[view] ?? 'press', 0.2)
}

/**
 * 音色包选项列表（供设置页渲染使用）。
 * 一个音色包决定同一事件音的听感：波形、谐波、噪声、混响、位深。
 * id 是存进设置里的值，标签用中文，界面按钮只显示中文。
 */
export const PACK_OPTIONS: { id: PackName; label: string; description: string }[] = [
  { id: 'minimal', label: '极简', description: '干爽精准，几乎不打扰，适合长时间待着的工具界面' },
  { id: 'soft', label: '柔和', description: '圆润温暖，不刺耳，安静环境下也不突兀' },
  { id: 'glass', label: '玻璃', description: '明亮通透，带一点高级感的晶体音色' },
  { id: 'arcade', label: '街机', description: '方块波，活泼带电玩味' },
  { id: 'mechanical', label: '机械', description: '开关继电般的硬朗咔哒感，适合开发工具' },
  { id: 'organic', label: '木质', description: '木头、水滴、小石子的自然质感' },
  { id: 'dreamy', label: '梦幻', description: '空灵铺展，尾音偏长，带轻微回声' },
  { id: 'scifi', label: '科幻', description: '全息感的干净叮声，克制数字味，适合 AI 工具' },
  { id: 'rubber', label: '橡胶', description: '有弹性的敲击，回弹很快' },
  { id: 'cinematic', label: '影视', description: '低频冲击加长尾音，有场面感' },
  { id: 'studio', label: '录音棚', description: '手感清晰的编辑质感，同时保持温暖克制' },
  { id: 'zen', label: '禅意', description: '纯净单音配短促纸质细节，最安静' },
]
