import { ReactNode, useEffect, useRef, useState } from 'react'
import { StoreProvider, useStore } from './store'
import PrivacyScreen from './components/PrivacyScreen'
import QuickSettings from './components/QuickSettings'
import ContinueView from './views/ContinueView'
import LibraryView from './views/LibraryView'
import ImportView from './views/ImportView'
import SettingsView from './views/SettingsView'
import ReaderView from './views/ReaderView'

function Shell(): ReactNode {
  const s = useStore()
  const stealth = s.stealth
  const immersive = stealth && s.view === 'reader' && s.privacyState === 'reading'

  // 快捷键（刻意精简）：
  //   Ctrl+,        打开/关闭「快速调节」面板——透明度/明暗/配色/字号/栏宽/栏高/置顶一站式调节
  //   Alt+Shift+Z   切换专注视图
  //   Esc           关闭调节面板；专注态下连按两下 Esc 隐藏到托盘
  const lastEsc = useRef(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault()
        s.toggleQuick()
        return
      }
      if (e.key === 'Escape') {
        if (s.quickOpen) {
          e.preventDefault()
          s.setQuickOpen(false)
          return
        }
        if (immersive) {
          const now = Date.now()
          if (now - lastEsc.current < 400) {
            e.preventDefault()
            lastEsc.current = 0
            void window.reader.hideToTray()
          } else {
            lastEsc.current = now
          }
        }
        return
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void s.toggleStealth()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, immersive])

  // 沉浸层：切换 body 类、透明度变量、文字配色/明暗、正文栏宽、窗口置顶
  useEffect(() => {
    document.body.classList.toggle('immersive', immersive)
    document.body.style.setProperty('--focus-opacity', String(s.focusOpacity))
    document.body.style.setProperty('--reader-width', `${s.settings?.readerWidth ?? 820}px`)
    document.body.style.setProperty('--reader-height', `${s.settings?.readerHeight ?? 100}%`)
    document.body.dataset.focusText = s.focusTextColor
    const b = s.focusTextBrightness ?? (s.focusTextColor === 'dark' ? 0.08 : 0.96)
    document.body.style.setProperty('--focus-brightness', String(b))
    const lightText = b >= 0.5
    document.body.style.setProperty('--focus-outline', lightText ? 'rgba(0, 0, 0, 0.9)' : 'rgba(255, 255, 255, 0.95)')
    document.body.style.setProperty('--focus-soft', lightText ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.7)')
    void window.reader.setAlwaysOnTop(immersive && s.focusAlwaysOnTop)
  }, [immersive, s.focusOpacity, s.focusTextColor, s.focusTextBrightness, s.focusAlwaysOnTop, s.settings?.readerWidth, s.settings?.readerHeight])

  // 专注悬浮态桌面可点击：把"要交互的区域"(正文带/底部控制条/快速调节面板)的客户区矩形
  // 报给主进程，由主进程按光标位置轮询切换点击穿透——比依赖渲染层 mousemove 更稳，
  // 拖动窗口(原生移动会冻结页面 JS)时也不会失效。退出专注态发送空数组即恢复整窗可交互。
  useEffect(() => {
    if (!immersive) {
      void window.reader.setFocusRects([])
      return
    }
    const SEL = '.reader-body, .focus-bar, .focus-hotzone, .quick-panel, .quick-backdrop'
    const send = (): void => {
      const rects: { x: number; y: number; width: number; height: number }[] = []
      document.querySelectorAll(SEL).forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, width: r.width, height: r.height })
      })
      void window.reader.setFocusRects(rects)
    }
    send()
    const id = setInterval(send, 200)
    window.addEventListener('resize', send)
    return () => {
      clearInterval(id)
      window.removeEventListener('resize', send)
      void window.reader.setFocusRects([])
    }
  }, [immersive])

  // 卸载时确保取消置顶，避免残留
  useEffect(() => () => void window.reader.setAlwaysOnTop(false), [])

  // 主题作用到 <html>：让 body（.app 的祖先）与中性遮盖屏都吃到主题变量，
  // 深色/护眼时整窗（含正文页）一起变深，而非只变工具栏。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', s.theme || 'light')
  }, [s.theme])

  if (!s.settings) return <div className="loading">正在准备工作区…</div>

  if (s.privacyState !== 'reading') return <PrivacyScreen state={s.privacyState as 'neutral' | 'locked'} />
  return (
    <div
      className="app"
      data-theme={s.theme}
      data-stealth={stealth ? '1' : undefined}
      data-immersive={immersive ? '1' : undefined}
    >
      <header className="topbar">
        <nav className="nav">
          <button className={s.view === 'continue' ? 'on' : ''} onClick={() => s.setView('continue')}>
            {stealth ? '最近' : '继续阅读'}
          </button>
          <button className={s.view === 'library' ? 'on' : ''} onClick={() => s.setView('library')}>
            {stealth ? '文件' : '书库'}
          </button>
          <button className={s.view === 'import' ? 'on' : ''} onClick={() => s.setView('import')}>
            导入
          </button>
          <button className={s.view === 'settings' ? 'on' : ''} onClick={() => s.setView('settings')}>
            设置
          </button>
        </nav>
        <GlobalSearch />
        <button
          className="quick-btn"
          onClick={() => s.toggleQuick()}
          title="快速调节（Ctrl+,）：字号、栏宽、透明度、文字明暗、配色、置顶"
        >
          ⚙ 调节
        </button>
        <button
          className={stealth ? 'focus-btn on' : 'focus-btn'}
          onClick={() => void s.toggleStealth()}
          title="切换到专注视图（Alt+Shift+Z）"
        >
          专注
        </button>
        <button className="hide-btn" onClick={() => window.reader.hide()} title={stealth ? '快速隐藏当前视图' : '快速隐藏阅读内容'}>
          隐藏
        </button>
        <div className="win-controls">
          <button className="win-btn" onClick={() => window.reader.minimizeWindow()} title="最小化">
            —
          </button>
          <button className="win-btn win-close" onClick={() => window.reader.closeWindow()} title="关闭">
            ✕
          </button>
        </div>
      </header>
      <main className="content">
        {s.view === 'continue' && <ContinueView />}
        {s.view === 'library' && <LibraryView />}
        {s.view === 'import' && <ImportView />}
        {s.view === 'settings' && <SettingsView />}
        {s.view === 'reader' && s.currentBookId && <ReaderView key={`${s.currentBookId}-${s.navSeq}`} bookId={s.currentBookId} />}
      </main>
      <QuickSettings />
    </div>
  )
}

function GlobalSearch(): ReactNode {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<unknown[]>([])
  const [open, setOpen] = useState(false)
  const s = useStore()

  const doSearch = async (): Promise<void> => {
    if (!q.trim()) return
    const r = await window.reader.search(q)
    setHits(r as never)
    setOpen(true)
  }

  return (
    <div className="searchbox">
      <input
        value={q}
        placeholder={s.stealth ? '搜索标题或内容' : '搜索书名、作者或已缓存正文'}
        onChange={(e) => {
          setQ(e.target.value)
          // 换搜索词时清掉旧结果，避免显示过期内容
          setHits([])
          setOpen(false)
        }}
        onKeyDown={(e) => e.key === 'Enter' && doSearch()}
      />
      {open && (
        <div className="search-pop" onMouseLeave={() => setOpen(false)}>
          {(hits as Array<{ bookId: number; bookTitle: string; chapterIdx: number; paraIdx: number; snippet: string }>).map(
            (h, i) => (
              <div
                key={`${h.bookId}-${h.chapterIdx}-${h.paraIdx}-${i}`}
                className="hit"
                onClick={() => {
                  s.openBook(h.bookId, { chapterIdx: h.chapterIdx, paraIdx: h.paraIdx })
                  setOpen(false)
                }}
              >
                <b>{h.bookTitle}</b>
                <span className="snip">{h.snippet.slice(0, 48)}</span>
              </div>
            )
          )}
          {hits.length === 0 && <div className="hit empty">没有匹配结果</div>}
        </div>
      )}
    </div>
  )
}

export default function App(): ReactNode {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
