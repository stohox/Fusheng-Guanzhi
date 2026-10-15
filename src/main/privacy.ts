import { globalShortcut, BrowserWindow, Tray, Menu, nativeImage, app } from 'electron'
import path from 'path'
import { loadSettings, saveSettings } from './settings'
import { cancelAllAi } from './ai'
import { hasPin, verifyPin, setPin as savePin, resetPin as clearPin } from './crypto'

export type PrivacyState = 'reading' | 'neutral' | 'locked'

let state: PrivacyState = 'reading'
let tray: Tray | null = null
let idleTimer: NodeJS.Timeout | null = null
let lastActivity = Date.now()
let onStateChange: ((s: PrivacyState) => void) | null = null
let hideToBackground = false

export function initPrivacy(cb: (s: PrivacyState) => void): void {
  onStateChange = cb
  const persisted = loadSettings().privacyState
  // 应用重启保持遮盖状态（PRD 验收：重启不自动恢复正文）
  state = persisted === 'locked' ? 'locked' : persisted === 'neutral' ? 'neutral' : 'reading'
  startIdleWatch()
}

export function getState(): PrivacyState {
  return state
}

function transition(next: PrivacyState): void {
  state = next
  saveSettings({ privacyState: next, lastHiddenAt: next === 'reading' ? loadSettings().lastHiddenAt : Date.now() })
  onStateChange?.(next)
}

export function hideWindow(win: BrowserWindow): void {
  if (state !== 'reading') return
  cancelAllAi() // 取消尚未发出的 AI 请求；返回结果暂不展示
  const s = loadSettings()
  win.setTitle(s.neutralTitle || '工作笔记')
  const next: PrivacyState = s.lockOnHide && hasPin() ? 'locked' : 'neutral'
  transition(next)
  if (hideToBackground) {
    win.hide()
    if (tray) tray.displayBalloon({ title: s.neutralTitle || '应用', content: '已最小化到通知区域' })
  }
}

// 直接隐藏到系统托盘（不切中性伪装界面）：状态保持 reading，点托盘即恢复专注浮层
export function hideToTray(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  cancelAllAi()
  win.hide()
  if (tray) tray.displayBalloon({ title: '已隐藏', content: '点击托盘图标可恢复阅读' })
}

// ---------------- PIN 防爆破 ----------------
// 4 位数字 PIN 组合空间只有 1 万，本地攻击者可在数分钟内暴力尝试。
// 这里做失败计数 + 指数退避：第 5 次起锁定 30s，之后每次翻倍，上限 10 分钟。
let pinFails = 0
let pinLockUntil = 0

export function revealWindow(win: BrowserWindow, pin: string): { ok: boolean; error?: string } {
  if (state === 'reading') return { ok: true }
  const now = Date.now()
  if (now < pinLockUntil) {
    return { ok: false, error: `尝试过于频繁，请 ${Math.ceil((pinLockUntil - now) / 1000)} 秒后重试` }
  }
  if (hasPin()) {
    if (!verifyPin(pin)) {
      pinFails++
      if (pinFails >= 5) {
        const delay = Math.min(30_000 * 2 ** (pinFails - 5), 600_000)
        pinLockUntil = now + delay
        return { ok: false, error: `PIN 已连续错误 ${pinFails} 次，请 ${Math.round(delay / 1000)} 秒后重试` }
      }
      return { ok: false, error: `PIN 不正确（已失败 ${pinFails} 次）` }
    }
    pinFails = 0
    pinLockUntil = 0
  }
  transition('reading')
  if (win.isDestroyed()) return { ok: true }
  if (!win.isVisible()) win.show()
  win.focus()
  return { ok: true }
}

export function neutralInteract(): void {
  lastActivity = Date.now()
}

export function setHideToBackground(v: boolean): void {
  hideToBackground = v
}

export function isHiddenToBackground(): boolean {
  return hideToBackground
}

// ---------------- 快捷键 ----------------
let registeredAccelerator = ''

export function registerHideShortcut(onTrigger: () => void): { ok: boolean; conflict: boolean } {
  const accel = loadSettings().globalShortcut
  if (registeredAccelerator === accel && globalShortcut.isRegistered(accel)) return { ok: true, conflict: false }
  if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator)
  let ok = false
  try {
    ok = globalShortcut.register(accel, onTrigger)
  } catch {
    ok = false
  }
  registeredAccelerator = ok ? accel : ''
  // 全局快捷键注册失败时退回应用内快捷键（由 index.ts 的 before-input-event 兜底）
  return { ok, conflict: !ok }
}

export function unregisterAllShortcuts(): void {
  globalShortcut.unregisterAll()
  registeredAccelerator = ''
}

// ---------------- 闲置隐藏 ----------------
function startIdleWatch(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = setInterval(() => {
    const s = loadSettings()
    if (!s.hideOnIdle || state !== 'reading') return
    if (Date.now() - lastActivity > Math.max(1, s.idleMinutes) * 60_000) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed() && win.isFocused()) hideWindow(win)
    }
  }, 15_000)
}

export function pingActivity(): void {
  lastActivity = Date.now()
}

// ---------------- 托盘 ----------------
export function createTray(win: BrowserWindow, onShow: () => void): void {
  if (tray) return
  // 优先用应用图标（书本）；打包后从 resources 目录取，开发态从项目 resources 取。
  // 找不到时回退到 16x16 纯色位图，保证托盘始终有图标不空白。
  let img: Electron.NativeImage | null = null
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tray.png')
      : path.join(app.getAppPath(), 'resources', 'tray.png')
    const loaded = nativeImage.createFromPath(iconPath)
    if (!loaded.isEmpty()) img = loaded
  } catch {
    /* 资源缺失，走回退 */
  }
  if (!img) {
    const size = 16
    const bmp = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      bmp[i * 4] = 0x60
      bmp[i * 4 + 1] = 0x60
      bmp[i * 4 + 2] = 0x60
      bmp[i * 4 + 3] = 0xff
    }
    img = nativeImage.createFromBitmap(bmp, { width: size, height: size })
  }
  tray = new Tray(img)
  tray.setToolTip(loadSettings().neutralTitle || '阅读器') // 通用文案，不含书名
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示应用',
        click: () => {
          onShow()
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', () => {
    if (state === 'reading') onShow()
    else win.show() // 隐藏态点击仅唤出中性界面
  })
}

// ---------------- PIN ----------------
export function setupPin(pin: string): { ok: boolean; error?: string } {
  if (!/^\d{4,10}$/.test(pin)) return { ok: false, error: 'PIN 需为 4-10 位数字' }
  savePin(pin)
  saveSettings({ pinConfigured: true })
  return { ok: true }
}

export function resetPin(): void {
  clearPin()
  saveSettings({ pinConfigured: false })
}

export function pinConfigured(): boolean {
  return hasPin()
}
