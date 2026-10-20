import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AiRequestPayload,
  AiResultPayload,
  ReadingProgress
} from '../shared/types'

const api = {
  // 设置
  getSettings: (): Promise<AppSettings & { hasPin: boolean; secureStorage: boolean }> =>
    ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<{ settings: AppSettings; shortcutConflict: boolean }> =>
    ipcRenderer.invoke('settings:set', patch),
  setApiKey: (key: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:setApiKey', key),

  // 隐私
  hide: (): Promise<string> => ipcRenderer.invoke('privacy:hide'),
  hideToTray: (): Promise<string> => ipcRenderer.invoke('privacy:hideToTray'),
  getState: (): Promise<string> => ipcRenderer.invoke('privacy:state'),
  reveal: (pin: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('privacy:reveal', pin),
  setupPin: (pin: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('privacy:setupPin', pin),
  resetPin: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('privacy:resetPin'),
  activity: (): void => {
    void ipcRenderer.invoke('privacy:activity')
  },
  onHideToBackground: (v: boolean): Promise<void> => ipcRenderer.invoke('privacy:setHideToBackground', v),

  // 窗口（无边框 / 专注悬浮）
  setAlwaysOnTop: (v: boolean): Promise<boolean> => ipcRenderer.invoke('window:setAlwaysOnTop', v),
  setFocusRects: (rects: { x: number; y: number; width: number; height: number }[]): Promise<boolean> =>
    ipcRenderer.invoke('window:setFocusRects', rects),
  minimizeWindow: (): void => {
    ipcRenderer.send('window:minimize')
  },
  closeWindow: (): void => {
    ipcRenderer.send('window:close')
  },

  // 图书
  listBooks: () => ipcRenderer.invoke('books:list'),
  getBook: (id: number) => ipcRenderer.invoke('books:get', id),
  updateBook: (id: number, patch: Record<string, unknown>) => ipcRenderer.invoke('books:update', id, patch),
  deleteBook: (id: number) => ipcRenderer.invoke('books:delete', id),
  restoreBook: (id: number) => ipcRenderer.invoke('books:restore', id),
  lockField: (id: number, field: string, locked: boolean) => ipcRenderer.invoke('books:lockField', id, field, locked),
  chapterMeta: (bookId: number) => ipcRenderer.invoke('chapters:meta', bookId),
  getChapter: (bookId: number, idx: number) => ipcRenderer.invoke('chapters:get', bookId, idx),

  // 书库/标签
  listLibraries: () => ipcRenderer.invoke('libraries:list'),
  createLibrary: (name: string, isPrivate: boolean) => ipcRenderer.invoke('libraries:create', name, isPrivate),
  renameLibrary: (id: number, name: string) => ipcRenderer.invoke('libraries:rename', id, name),
  removeLibrary: (id: number, alsoDeleteContent: boolean) => ipcRenderer.invoke('libraries:remove', id, alsoDeleteContent),
  listTags: () => ipcRenderer.invoke('tags:list'),
  librariesOf: (bookId: number) => ipcRenderer.invoke('relations:librariesOf', bookId),
  tagsOf: (bookId: number) => ipcRenderer.invoke('relations:tagsOf', bookId),
  booksRelations: (): Promise<Record<number, { libraries: number[]; tags: string[] }>> =>
    ipcRenderer.invoke('relations:bulk'),
  setLibraries: (bookId: number, ids: number[]) => ipcRenderer.invoke('relations:setLibraries', bookId, ids),
  setTags: (bookId: number, names: string[]) => ipcRenderer.invoke('relations:setTags', bookId, names),

  // 分类
  applySuggestion: (bookId: number) => ipcRenderer.invoke('books:applySuggestion', bookId),
  dismissSuggestion: (bookId: number) => ipcRenderer.invoke('books:dismissSuggestion', bookId),
  reanalyze: (bookId: number) => ipcRenderer.invoke('books:reanalyze', bookId),
  listRules: () => ipcRenderer.invoke('rules:list'),
  addRule: (field: string, value: string, libraryId: number, priority: number) =>
    ipcRenderer.invoke('rules:add', field, value, libraryId, priority),
  removeRule: (id: number) => ipcRenderer.invoke('rules:remove', id),

  // 阅读状态
  saveProgress: (p: ReadingProgress) => ipcRenderer.invoke('progress:save', p),
  getProgress: (bookId: number) => ipcRenderer.invoke('progress:get', bookId),
  recentBooks: (limit?: number) => ipcRenderer.invoke('progress:recent', limit),
  listBookmarks: (bookId?: number) => ipcRenderer.invoke('bookmarks:list', bookId),
  addBookmark: (bookId: number, ci: number, pi: number, label: string) =>
    ipcRenderer.invoke('bookmarks:add', bookId, ci, pi, label),
  removeBookmark: (id: number) => ipcRenderer.invoke('bookmarks:remove', id),
  listAnnotations: (bookId: number) => ipcRenderer.invoke('annotations:list', bookId),
  addAnnotation: (a: Record<string, unknown>) => ipcRenderer.invoke('annotations:add', a),
  updateAnnotation: (id: number, note: string) => ipcRenderer.invoke('annotations:update', id, note),
  removeAnnotation: (id: number) => ipcRenderer.invoke('annotations:remove', id),

  // 搜索 / 回收站
  search: (q: string, bookId?: number) => ipcRenderer.invoke('search:query', q, bookId),
  listTrash: () => ipcRenderer.invoke('trash:list'),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),

  // 导入
  pickImport: (): Promise<string | null> => ipcRenderer.invoke('import:pick'),
  createImport: (filePath: string): Promise<string> => ipcRenderer.invoke('import:create', filePath),
  getTask: (id: string) => ipcRenderer.invoke('import:task', id),
  confirmImport: (payload: Record<string, unknown>) => ipcRenderer.invoke('import:confirm', payload),
  cancelImport: (id: string, keepPartial: boolean) => ipcRenderer.invoke('import:cancel', id, keepPartial),

  // AI
  aiRequest: (payload: AiRequestPayload): Promise<AiResultPayload> => ipcRenderer.invoke('ai:request', payload),
  aiCancel: (requestId: string) => ipcRenderer.invoke('ai:cancel', requestId),
  aiClearCache: () => ipcRenderer.invoke('ai:clearCache'),
  aiStats: () => ipcRenderer.invoke('ai:stats'),

  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  ready: () => ipcRenderer.send('window:ready'),

  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    const allowed = ['privacy:state', 'privacy:focus-input', 'import:task', 'tray:command']
    if (!allowed.includes(channel)) return () => undefined
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('reader', api)

export type ReaderApi = typeof api
