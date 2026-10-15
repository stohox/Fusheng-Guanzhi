import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback, useMemo } from 'react'
import type { AppSettings, Book, Library, Tag } from '../../shared/types'

export type View = 'continue' | 'library' | 'import' | 'settings' | 'reader'

interface Store {
  settings: (AppSettings & { hasPin?: boolean; secureStorage?: boolean }) | null
  privacyState: string
  view: View
  setView: (v: View) => void
  openBook: (id: number, anchor?: { chapterIdx: number; paraIdx: number }) => void
  currentBookId: number | null
  currentAnchor: { chapterIdx: number; paraIdx: number } | null
  books: Book[]
  libraries: Library[]
  tags: Tag[]
  refreshBooks: () => Promise<void>
  refreshLibraries: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<{ shortcutConflict: boolean } | void>
  theme: string
  setTheme: (t: string) => void
  stealth: boolean
  toggleStealth: () => Promise<void>
  focusOpacity: number
  focusAlwaysOnTop: boolean
  toggleAlwaysOnTop: () => Promise<void>
  focusTextColor: 'light' | 'dark'
  focusTextBrightness: number
  toggleTextColor: () => Promise<void>
  quickOpen: boolean
  setQuickOpen: (b: boolean) => void
  toggleQuick: () => void
}

const Ctx = createContext<Store>(null as never)
export const useStore = (): Store => useContext(Ctx)

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState<AppSettings & { hasPin?: boolean; secureStorage?: boolean } | null>(null)
  const [privacyState, setPrivacyState] = useState('reading')
  const [view, setView] = useState<View>('continue')
  const [currentBookId, setCurrentBookId] = useState<number | null>(null)
  const [currentAnchor, setCurrentAnchor] = useState<{ chapterIdx: number; paraIdx: number } | null>(null)
  const [books, setBooks] = useState<Book[]>([])
  const [libraries, setLibraries] = useState<Library[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [theme, setTheme] = useState('light')
  const [quickOpen, setQuickOpen] = useState(false)

  const loadSettings = useCallback(async () => {
    const s = await window.reader.getSettings()
    setSettings(s)
    setTheme(s.readerTheme || 'light')
  }, [])

  useEffect(() => {
    loadSettings()
    window.reader.ready()
    const off1 = window.reader.on('privacy:state', (s) => setPrivacyState(String(s)))
    const st = async () => setPrivacyState(await window.reader.getState())
    st()
    return () => off1()
  }, [loadSettings])

  // 用户活动上报（闲置计时的依据）
  const lastPing = useRef(0)
  useEffect(() => {
    const handler = (): void => {
      const now = Date.now()
      if (now - lastPing.current > 10_000) {
        lastPing.current = now
        window.reader.activity()
      }
    }
    window.addEventListener('pointerdown', handler)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('keydown', handler)
    }
  }, [])

  const refreshBooks = useCallback(async () => {
    setBooks(await window.reader.listBooks())
    setTags(await window.reader.listTags())
  }, [])
  const refreshLibraries = useCallback(async () => {
    setLibraries(await window.reader.listLibraries())
  }, [])

  useEffect(() => {
    refreshBooks()
    refreshLibraries()
  }, [refreshBooks, refreshLibraries])

  const openBook = useCallback((id: number, anchor?: { chapterIdx: number; paraIdx: number }) => {
    setCurrentBookId(id)
    setCurrentAnchor(anchor ?? null)
    setView('reader')
  }, [])

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const r = await window.reader.setSettings(patch)
      await loadSettings()
      if (patch.readerTheme) setTheme(patch.readerTheme)
      return { shortcutConflict: r.shortcutConflict }
    },
    [loadSettings]
  )

  const toggleStealth = useCallback(async () => {
    const next = !(settings?.stealthMode ?? false)
    await window.reader.setSettings({ stealthMode: next })
    await loadSettings()
  }, [settings, loadSettings])

  const toggleAlwaysOnTop = useCallback(async () => {
    const next = !(settings?.focusAlwaysOnTop ?? true)
    await window.reader.setSettings({ focusAlwaysOnTop: next })
    await loadSettings()
  }, [settings, loadSettings])

  const toggleTextColor = useCallback(async () => {
    const next = (settings?.focusTextColor ?? 'light') === 'light' ? 'dark' : 'light'
    await window.reader.setSettings({
      focusTextColor: next,
      focusTextBrightness: next === 'light' ? 0.96 : 0.08
    })
    await loadSettings()
  }, [settings, loadSettings])

  const toggleQuick = useCallback(() => setQuickOpen((v) => !v), [])

  // memo 化：此前每次渲染都重建 store 对象 → 所有 useStore 消费者全量重渲染；
  // 与 ReaderView 的段落追踪叠加会放大滚动链路的开销。
  const store: Store = useMemo(
    () => ({
      settings,
      privacyState,
      view,
      setView,
      openBook,
      currentBookId,
      currentAnchor,
      books,
      libraries,
      tags,
      refreshBooks,
      refreshLibraries,
      updateSettings,
      theme,
      setTheme,
      stealth: settings?.stealthMode ?? false,
      toggleStealth,
      focusOpacity: settings?.focusOpacity ?? 0.9,
      focusAlwaysOnTop: settings?.focusAlwaysOnTop ?? true,
      toggleAlwaysOnTop,
      focusTextColor: settings?.focusTextColor ?? 'light',
      focusTextBrightness: settings?.focusTextBrightness ?? 0.96,
      toggleTextColor,
      quickOpen,
      setQuickOpen,
      toggleQuick
    }),
    [
      settings, privacyState, view, currentBookId, currentAnchor, books, libraries, tags,
      theme, quickOpen, refreshBooks, refreshLibraries, openBook, updateSettings,
      toggleStealth, toggleAlwaysOnTop, toggleTextColor, toggleQuick
    ]
  )

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
