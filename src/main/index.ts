import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import path from 'path'
import {
  initDb,
  persistNow,
  books,
  chapters,
  libraries,
  tags,
  relations,
  bookmarks,
  annotations,
  progress,
  rules,
  aiCache,
  search,
  trash,
  booksRelations
} from './db'
import { getMasterKey, decryptWithKey, registerDecryptor, hasPin, isStorageProtected } from './crypto'
import { loadSettings, saveSettings, setApiKey, getApiKey } from './settings'
import * as importer from './importer'
import { runAi, cancelAi, cancelAllAi } from './ai'
import {
  initPrivacy,
  hideWindow,
  hideToTray,
  revealWindow,
  registerHideShortcut,
  unregisterAllShortcuts,
  createTray,
  pingActivity,
  setupPin,
  resetPin,
  getState,
  setHideToBackground
} from './privacy'

let win: BrowserWindow | null = null
let suppressingBlur = false

// --- 专注悬浮态：透明留白点击穿透到桌面（主进程按光标位置轮询切换，比渲染层 mousemove 更稳，拖窗时不失效） ---
interface ClientRect {
  x: number
  y: number
  width: number
  height: number
}
let focusRects: ClientRect[] = []
let focusPoll: ReturnType<typeof setInterval> | null = null
let lastIgnored = false
const PAD = 8 // 交互区四周留 8px 容差，贴边也好点

function applyThrough(ignore: boolean): void {
  if (!win || win.isDestroyed() || ignore === lastIgnored) return
  lastIgnored = ignore
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

function startFocusThroughPoll(): void {
  if (focusPoll) return
  focusPoll = setInterval(() => {
    if (!win || win.isDestroyed()) return
    if (!focusRects.length) {
      applyThrough(false)
      return
    }
    const cb = win.getContentBounds()
    const p = screen.getCursorScreenPoint()
    const inside = focusRects.some((r) => {
      const x = cb.x + r.x - PAD
      const y = cb.y + r.y - PAD
      return p.x >= x && p.x <= x + r.width + PAD * 2 && p.y >= y && p.y <= y + r.height + PAD * 2
    })
    applyThrough(!inside)
  }, 40)
}

function stopFocusThrough(): void {
  if (focusPoll) {
    clearInterval(focusPoll)
    focusPoll = null
  }
  focusRects = []
  applyThrough(false)
}

// 窗口几何持久化：专注悬浮层/普通窗移动或缩放后记住位置，重启时回到上次位置而非正中。
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
// 保存的位置必须仍落在某个显示器的范围内（换屏/拔副屏后不至于把窗口藏到看不见的坐标）
function boundsOnScreen(b: Bounds): boolean {
  return screen
    .getAllDisplays()
    .some((d) => {
      const a = d.bounds
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
    })
}

function restoreBounds(): Partial<Electron.BrowserWindowConstructorOptions> {
  const saved = loadSettings().windowBounds
  if (saved && saved.width >= 480 && saved.height >= 420 && boundsOnScreen(saved)) {
    return { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  }
  return { width: 1200, height: 800 }
}

let boundsTimer: ReturnType<typeof setTimeout> | null = null
function persistBoundsSoon(): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
    const b = win.getBounds()
    // 最大化时 getBounds 返回整屏，存下来重启会错位——忽略，仅记普通态几何
    if (b.width >= 480 && b.height >= 420) saveSettings({ windowBounds: b })
  }, 400)
}

function createWindow(): void {
  win = new BrowserWindow({
    ...restoreBounds(),
    minWidth: 480,
    minHeight: 420,
    show: true,
    frame: false, // 无边框：正常模式用自绘顶栏，专注模式可做到只剩文字
    transparent: true, // 透明窗口：专注模式下背景透出，浮在其他软件上
    backgroundColor: '#00000000',
    hasShadow: true,
    title: windowTitle(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('blur', () => {
    if (suppressingBlur) return
    const st = loadSettings()
    if (st.hideOnBlur && getState() === 'reading' && win && !win.isDestroyed()) hideWindow(win)
  })

  // 记住窗口位置/大小（含专注悬浮层被拖动后的落点）
  win.on('moved', persistBoundsSoon)
  win.on('resized', persistBoundsSoon)

  // 窗口关闭时清理专注穿透轮询，避免定时器泄漏
  win.on('closed', () => stopFocusThrough())

  // 应用内快捷键兜底（窗口聚焦时始终可用）
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (matchAccelerator(input, loadSettings().globalShortcut)) triggerHide()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function matchAccelerator(input: Electron.Input, accel: string): boolean {
  const parts = accel.toLowerCase().split('+').map((p) => p.trim())
  const key = parts[parts.length - 1]
  const needAlt = parts.includes('alt')
  const needCtrl = parts.includes('ctrl') || parts.includes('commandorcontrol')
  const needShift = parts.includes('shift')
  const needMeta = parts.includes('super') || parts.includes('command')
  const hasCtrl = (input as unknown as { ctrl?: boolean }).ctrl ?? (input as unknown as { control?: boolean }).control ?? false
  return (
    input.key.toLowerCase() === key &&
    input.alt === needAlt &&
    hasCtrl === needCtrl &&
    input.shift === needShift &&
    input.meta === needMeta
  )
}

function triggerHide(): void {
  if (!win || win.isDestroyed()) return
  if (getState() === 'reading') {
    hideWindow(win)
  } else {
    win.show()
    win.webContents.send('privacy:focus-input') // 用户点击回来时聚焦 PIN 输入
  }
}

function sendState(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('privacy:state', getState())
    win.setTitle(windowTitle())
  }
}

// 窗口标题：隐身模式开启时，即使处于阅读态也保持中性标题，避免任务栏/标题栏露馅
function windowTitle(): string {
  const s = loadSettings()
  if (getState() === 'reading' && !s.stealthMode) return '阅读'
  return s.neutralTitle || '工作笔记'
}

// ================= IPC =================
function registerIpc(): void {
  // --- 设置 ---
  ipcMain.handle('settings:get', () => {
    const s = loadSettings()
    return { ...s, aiHasKey: !!getApiKey(), hasPin: hasPin(), secureStorage: isStorageProtected() }
  })
  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => {
    const before = loadSettings()
    const applied = saveSettings(patch as never)
    if (patch.globalShortcut && patch.globalShortcut !== before.globalShortcut && win) {
      const r = registerHideShortcut(triggerHide)
      return { settings: applied, shortcutConflict: !r.ok }
    }
    if ((patch.neutralTitle !== undefined || patch.stealthMode !== undefined) && win && !win.isDestroyed()) {
      win.setTitle(windowTitle())
    }
    return { settings: applied, shortcutConflict: false }
  })
  ipcMain.handle('settings:setApiKey', (_e, key: string) => {
    setApiKey(String(key || ''))
    saveSettings({ aiHasKey: !!key })
    return { ok: true }
  })

  // --- 隐私 ---
  ipcMain.handle('privacy:hide', () => {
    if (win) hideWindow(win)
    return getState()
  })
  ipcMain.handle('privacy:hideToTray', () => {
    if (win) hideToTray(win)
    return getState()
  })
  ipcMain.handle('privacy:state', () => getState())
  ipcMain.handle('privacy:reveal', (_e, pin: string) => {
    if (!win) return { ok: true }
    const r = revealWindow(win, String(pin || ''))
    if (r.ok) suppressBlurBriefly()
    sendState()
    return r
  })
  ipcMain.handle('privacy:setupPin', (_e, pin: string) => setupPin(String(pin || '')))
  ipcMain.handle('privacy:resetPin', () => {
    // 忘记 PIN：只能重置本机锁与受保护缓存（隐私书库正文不可再解密）
    const privateLibIds = libraries.list().filter((l) => l.isPrivate).map((l) => l.id)
    for (const b of books.list()) {
      if (relations.librariesOf(b.id).some((lid) => privateLibIds.includes(lid))) {
        books.purge(b.id)
      }
    }
    resetPin()
    return { ok: true }
  })
  ipcMain.handle('privacy:activity', () => pingActivity())
  ipcMain.handle('privacy:setHideToBackground', (_e, v: boolean) => setHideToBackground(!!v))

  // --- 窗口（无边框/专注悬浮） ---
  ipcMain.handle('window:setAlwaysOnTop', (_e, v: boolean) => {
    if (!win || win.isDestroyed()) return false
    win.setAlwaysOnTop(!!v, 'screen-saver')
    return v ? win.isAlwaysOnTop() : false
  })
  // 专注悬浮态：渲染层上报"要交互的区域"(正文带/控制条/调节面板)的客户区矩形数组。
  // 主进程按光标位置轮询，光标落在这些区域外时让点击穿透到桌面，落在其上时恢复交互。
  // 传空数组表示退出专注态 → 立即停止穿透、恢复整窗可交互。
  ipcMain.handle('window:setFocusRects', (_e, rects: ClientRect[]) => {
    if (!win || win.isDestroyed()) return false
    if (Array.isArray(rects) && rects.length) {
      focusRects = rects
      startFocusThroughPoll()
    } else {
      stopFocusThrough()
    }
    return true
  })
  ipcMain.on('window:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize()
  })
  ipcMain.on('window:close', () => {
    if (win && !win.isDestroyed()) win.close()
  })

  // --- 图书与章节 ---
  ipcMain.handle('books:list', () => books.list())
  ipcMain.handle('books:get', (_e, id: number) => books.get(id))
  ipcMain.handle('books:update', (_e, id: number, patch: Record<string, unknown>) => {
    books.update(id, patch as never)
    return books.get(id)
  })
  ipcMain.handle('books:delete', (_e, id: number) => {
    books.update(id, { deletedAt: Date.now() }) // 进回收站
    return true
  })
  ipcMain.handle('books:restore', (_e, id: number) => {
    books.update(id, { deletedAt: null })
    return true
  })
  ipcMain.handle('books:lockField', (_e, id: number, field: string, locked: boolean) => {
    const b = books.get(id)
    if (!b) return null
    const set = new Set(b.lockedFields)
    locked ? set.add(field) : set.delete(field)
    books.update(id, { lockedFields: [...set] })
    return books.get(id)
  })
  ipcMain.handle('chapters:meta', (_e, bookId: number) => chapters.meta(bookId))
  ipcMain.handle('chapters:get', (_e, bookId: number, idx: number) => {
    const ch = chapters.get(bookId, idx)
    if (!ch || !ch.raw) return null
    let paras: string[] = []
    try {
      paras = JSON.parse(ch.encrypted ? decryptWithKey(ch.raw, getMasterKey()) : ch.raw)
    } catch {
      // 解密失败可能因 PIN 重置，也可能因 DPAPI/安全存储环境变化（换机/系统变更），两者都提示
      return { ...ch, paragraphs: [], error: 'content-unreadable' }
    }
    return { ...ch, paragraphs: paras }
  })

  // --- 书库 / 标签 / 关系 ---
  ipcMain.handle('libraries:list', () => libraries.list())
  ipcMain.handle('libraries:create', (_e, name: string, isPrivate: boolean) => libraries.create(name, !!isPrivate))
  ipcMain.handle('libraries:rename', (_e, id: number, name: string) => (libraries.rename(id, name), true))
  ipcMain.handle('libraries:remove', (_e, id: number, alsoDeleteContent: boolean) => {
    if (alsoDeleteContent) {
      for (const bid of relations.booksInLibrary(id)) books.update(bid, { deletedAt: Date.now() })
    }
    libraries.remove(id) // 默认只解除归属
    return true
  })
  ipcMain.handle('tags:list', () => tags.list())
  ipcMain.handle('relations:librariesOf', (_e, bookId: number) => relations.librariesOf(bookId))
  ipcMain.handle('relations:tagsOf', (_e, bookId: number) => relations.tagsOf(bookId))
  // 批量关系：书库页一次拉全量映射，替代逐书 2 次 IPC 的串行往返
  ipcMain.handle('relations:bulk', () => booksRelations())
  ipcMain.handle('relations:setLibraries', (_e, bookId: number, ids: number[]) => {
    relations.setLibraries(bookId, ids)
    const b = books.get(bookId)
    if (b && !b.lockedFields.includes('library')) books.update(bookId, { lockedFields: [...b.lockedFields, 'library'] })
    return true
  })
  ipcMain.handle('relations:setTags', (_e, bookId: number, names: string[]) => {
    relations.setTags(bookId, names)
    const b = books.get(bookId)
    if (b && !b.lockedFields.includes('tags')) books.update(bookId, { lockedFields: [...b.lockedFields, 'tags'] })
    return true
  })

  // --- 分类建议与规则 ---
  ipcMain.handle('books:applySuggestion', (_e, bookId: number) => {
    const b = books.get(bookId)
    if (!b?.suggestion) return null
    let lid = b.suggestion.libraryId
    if (!lid && b.suggestion.libraryName) lid = libraries.create(b.suggestion.libraryName, false)
    if (lid) relations.addLibrary(bookId, lid)
    if (b.suggestion.tags.length) {
      const cur = relations.tagsOf(bookId).map((t) => t.name)
      relations.setTags(bookId, [...new Set([...cur, ...b.suggestion.tags])])
    }
    books.update(bookId, { suggestion: { ...b.suggestion, status: 'applied' } })
    return books.get(bookId)
  })
  ipcMain.handle('books:dismissSuggestion', (_e, bookId: number) => {
    const b = books.get(bookId)
    if (!b?.suggestion) return null
    books.update(bookId, { suggestion: { ...b.suggestion, status: 'dismissed' } })
    return books.get(bookId)
  })
  ipcMain.handle('books:reanalyze', (_e, bookId: number) => {
    const b = books.get(bookId)
    if (!b) return null
    const first = chapters.get(bookId, 0)
    let sample = ''
    if (first?.raw) {
      try {
        const paras: string[] = JSON.parse(first.encrypted ? decryptWithKey(first.raw, getMasterKey()) : first.raw)
        sample = paras.join('\n')
      } catch {
        sample = ''
      }
    }
    const s = importer.suggestClassification(b.title, b.author, b.language, sample)
    if (!b.lockedFields.includes('library')) books.update(bookId, { suggestion: s })
    return books.get(bookId)
  })
  ipcMain.handle('rules:list', () => rules.list())
  ipcMain.handle('rules:add', (_e, field: string, value: string, libraryId: number, priority: number) =>
    rules.add(field, value, libraryId, priority)
  )
  ipcMain.handle('rules:remove', (_e, id: number) => (rules.remove(id), true))

  // --- 阅读状态 ---
  ipcMain.handle('progress:save', (_e, p: Parameters<typeof progress.save>[0]) => (progress.save(p), true))
  ipcMain.handle('progress:get', (_e, bookId: number) => progress.get(bookId))
  ipcMain.handle('progress:recent', (_e, limit?: number) => progress.recent(limit ?? 8))
  ipcMain.handle('bookmarks:list', (_e, bookId?: number) => bookmarks.list(bookId))
  ipcMain.handle('bookmarks:add', (_e, bookId: number, ci: number, pi: number, label: string) =>
    bookmarks.add(bookId, ci, pi, label)
  )
  ipcMain.handle('bookmarks:remove', (_e, id: number) => (bookmarks.remove(id), true))
  ipcMain.handle('annotations:list', (_e, bookId: number) => annotations.list(bookId))
  ipcMain.handle('annotations:add', (_e, a: Parameters<typeof annotations.add>[0]) => annotations.add(a))
  ipcMain.handle('annotations:update', (_e, id: number, note: string) => (annotations.updateNote(id, note), true))
  ipcMain.handle('annotations:remove', (_e, id: number) => (annotations.remove(id), true))

  // --- 搜索与回收站 ---
  ipcMain.handle('search:query', (_e, q: string, bookId?: number) => search(q, bookId))
  ipcMain.handle('trash:list', () => trash.list())
  ipcMain.handle('trash:empty', () => (trash.empty(), true))

  // --- 导入 ---
  // 把导入任务的状态变化推送给渲染进程（渲染层依赖此事件更新进度，否则永远停在“排队中”）
  importer.onTaskUpdate((task) => {
    if (win && !win.isDestroyed()) win.webContents.send('import:task', task)
  })
  ipcMain.handle('import:pick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件',
      filters: [
        { name: '书籍文本', extensions: ['txt', 'epub', 'md'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths.length) return null
    return importer.createImportTask(r.filePaths[0]).id
  })
  ipcMain.handle('import:create', (_e, filePath: string) => importer.createImportTask(String(filePath)).id)
  ipcMain.handle('import:task', (_e, id: string) => importer.getTask(id))
  ipcMain.handle('import:confirm', (_e, payload: Omit<importer.ConfirmImportPayload, 'keyProvider'>) =>
    importer.confirmImport({ ...payload, keyProvider: getMasterKey })
  )
  ipcMain.handle('import:cancel', (_e, id: string, keepPartial: boolean) => (importer.cancelTask(id, keepPartial), true))
  ipcMain.handle('import:openPath', async (_e) => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      filters: [{ name: '书籍文本', extensions: ['txt', 'epub', 'md'] }],
      properties: ['openFile']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // --- AI ---
  ipcMain.handle('ai:request', async (_e, payload: Parameters<typeof runAi>[0]) => {
    if (getState() !== 'reading') return { requestId: payload.requestId, ok: false, canceled: true } // 锁定态不展示结果
    const r = await runAi(payload)
    if (getState() !== 'reading') return { ...r, ok: false, canceled: true } // 返回时已隐藏：丢弃展示
    return r
  })
  ipcMain.handle('ai:cancel', (_e, requestId: string) => (cancelAi(requestId), true))
  ipcMain.handle('ai:clearCache', () => (aiCache.clear(), true))
  ipcMain.handle('ai:stats', () => aiCache.stats())
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return true
  })
}

// reveal 后短暂忽略 blur（PIN 弹窗关闭时的焦点抖动）
function suppressBlurBriefly(): void {
  suppressingBlur = true
  setTimeout(() => (suppressingBlur = false), 600)
}

// ================= 生命周期 =================
// 单实例锁：sql.js 是整文件覆盖式持久化，多个实例同时运行会互相冲掉数据。
// 第二个实例直接退出，并唤起已有窗口。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      if (getState() === 'reading') {
        win.show()
        win.focus()
      }
    }
  })

  app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.leo.privacy-reader')

  initDb().then(() => {
    registerDecryptor((payload) => decryptWithKey(payload, getMasterKey()))
    registerIpc()
    // 回收站 30 天清理：启动时执行一次，此后每 24 小时兜底（长期挂机也能清）
    books.purgeDeleted()
    setInterval(() => books.purgeDeleted(), 24 * 3600 * 1000).unref()
    createWindow()
    if (!win) return
    initPrivacy((s) => {
      if (s === 'reading') suppressBlurBriefly()
      sendState()
    })
    sendState()
    createTray(win, () => {
      if (getState() !== 'reading' && !hasPin()) {
        // 未设置 PIN：托盘“显示”只带出中性界面，仍需界面内解锁操作
      }
      win?.show()
      win?.focus()
      sendState()
    })
    const r = registerHideShortcut(triggerHide)
    if (!r.ok) console.warn('全局快捷键注册失败，已退回应用内快捷键与隐藏按钮')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
}

app.on('window-all-closed', () => {
  persistNow()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cancelAllAi()
  unregisterAllShortcuts()
  persistNow()
})

ipcMain.on('window:ready', () => sendState())
