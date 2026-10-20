import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Annotation, Bookmark, Chapter } from '../../../shared/types'
import AiPanel from '../components/AiPanel'
import { convertParas, convertText, nextScript, SCRIPT_LABEL, type ScriptMode } from '../script'

export interface SelectionInfo {
  chapterIdx: number
  paraIdx: number
  startOffset: number
  endOffset: number
  text: string
  prevContext: string
  nextContext: string
  task?: 'translate' | 'explain' | 'qa'
}

export default function ReaderView({ bookId }: { bookId: number }): ReactNode {
  const s = useStore()
  const [book, setBook] = useState<Awaited<ReturnType<typeof window.reader.getBook>> | null>(null)
  const [meta, setMeta] = useState<{ idx: number; title: string; wordCount: number }[]>([])
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [chapterIdx, setChapterIdx] = useState(0)
  const [paraIdx, setParaIdx] = useState(0)
  const [panel, setPanel] = useState<'toc' | 'notes' | 'ai' | 'search' | null>(() => (s.stealth ? null : 'toc'))
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [searchQ, setSearchQ] = useState('')
  const [hits, setHits] = useState<unknown[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<{ chapter: number; para: number; context: string }>({ chapter: 0, para: 0, context: '' })
  const restoredRef = useRef(false)
  const firstChapterDone = useRef(false)
  const pendingPos = useRef<'top' | 'bottom' | null>(null)
  const [ready, setReady] = useState(false)
  const initTargetRef = useRef<{ chapter: number; para: number; context: string } | null>(null)

  // 加载书与目录，并一次性解析「续读目标」（章节+段落+上下文）后再放行章节加载，
  // 彻底消除「先按第 0 章预加载、再异步跳章」导致一次性恢复标志被提前消耗的竞态。
  useEffect(() => {
    restoredRef.current = false
    firstChapterDone.current = false
    pendingPos.current = null
    initTargetRef.current = null
    setReady(false)
    setChapter(null)
    let cancelled = false
    window.reader.getBook(bookId).then((b) => !cancelled && setBook(b as never))
    window.reader.chapterMeta(bookId).then((m) => !cancelled && setMeta(m as never))
    void (async () => {
      const t = { chapter: 0, para: 0, context: '' }
      if (s.currentAnchor) {
        t.chapter = s.currentAnchor.chapterIdx
        t.para = s.currentAnchor.paraIdx ?? 0
      } else {
        const p = await window.reader.getProgress(bookId)
        if (p) {
          const pp = p as never as { chapterIdx: number; paraIdx: number; context: string }
          t.chapter = pp.chapterIdx
          t.para = pp.paraIdx
          t.context = pp.context || ''
        }
      }
      if (cancelled) return
      initTargetRef.current = t
      setChapterIdx(t.chapter)
      setReady(true)
    })()
    refreshSide()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  const refreshSide = useCallback(async () => {
    setAnnotations((await window.reader.listAnnotations(bookId)) as never)
    setBookmarks((await window.reader.listBookmarks(bookId)) as never)
  }, [bookId])

  // 章节加载：仅在续读目标解析完成（ready）后放行，避免加载错章
  useEffect(() => {
    if (!ready) return
    window.reader.getChapter(bookId, chapterIdx).then((c) => {
      setChapter(c as never)
      setSelection(null)
      setToolbar(null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterIdx, ready])

  // 章节内容就位后的滚动定位：
  // 1) 命中「续读目标章」时做一次段落级精确回跳（用上下文片段校验正文更新后的锚点漂移）；
  // 2) 其余章节切换沿用翻页语义——新章置顶、回到上一章置底。
  useEffect(() => {
    if (!chapter || !bodyRef.current) return
    const t = initTargetRef.current
    if (t && !restoredRef.current && t.chapter === chapterIdx) {
      restoredRef.current = true
      firstChapterDone.current = true
      initTargetRef.current = null
      let target = t.para
      const txt = chapter.paragraphs[target] ?? ''
      if (t.context && txt && !txt.startsWith(t.context)) {
        const found = chapter.paragraphs.findIndex((x) => x.includes(t.context))
        if (found >= 0) target = found
      }
      if (target > 0) {
        bodyRef.current.querySelector(`[data-pidx="${target}"]`)?.scrollIntoView({ block: 'start' })
        setParaIdx(target)
      } else {
        bodyRef.current.scrollTop = 0
      }
      return
    }
    if (!firstChapterDone.current) {
      firstChapterDone.current = true
      pendingPos.current = null
      return
    }
    if (pendingPos.current === 'bottom') {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'auto' })
    } else {
      bodyRef.current.scrollTop = 0
    }
    pendingPos.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, chapterIdx])

  // 按屏翻一页：dir>0 下一页、dir<0 上一页；到章末自动进下一章（新章置顶）、章首自动回上一章（上一章置底）
  const turnPage = useCallback(
    (dir: 1 | -1): void => {
      const body = bodyRef.current
      if (!body) return
      const page = Math.max(body.clientHeight * 0.9, 40)
      if (dir > 0) {
        const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4
        if (atBottom) {
          if (chapterIdx < meta.length - 1) {
            pendingPos.current = 'top'
            setChapterIdx(chapterIdx + 1)
          }
        } else {
          body.scrollBy({ top: page, behavior: 'smooth' })
        }
      } else {
        const atTop = body.scrollTop <= 4
        if (atTop) {
          if (chapterIdx > 0) {
            pendingPos.current = 'bottom'
            setChapterIdx(chapterIdx - 1)
          }
        } else {
          body.scrollBy({ top: -page, behavior: 'smooth' })
        }
      }
    },
    [chapterIdx, meta.length]
  )

  // 键盘按屏翻页：空格/→/↓/PgDn 下一页，↑/←/PgUp 上一页
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return
        if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Spacebar')) return
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const body = bodyRef.current
      if (!body) return
      const k = e.key
      const isNext = k === ' ' || k === 'Spacebar' || k === 'PageDown' || k === 'ArrowRight' || k === 'ArrowDown'
      const isPrev = k === 'PageUp' || k === 'ArrowLeft' || k === 'ArrowUp'
      if (isNext) {
        e.preventDefault()
        turnPage(1)
      } else if (isPrev) {
        e.preventDefault()
        turnPage(-1)
      } else if (k === 'Home') {
        e.preventDefault()
        body.scrollTo({ top: 0, behavior: 'smooth' })
      } else if (k === 'End') {
        e.preventDefault()
        body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turnPage])

  // 滚轮：普通滚动 = 按屏翻页（一次滚动一格，含章末/章首自动跨章）；Ctrl + 滚轮 = 缩放字号
  useEffect(() => {
    const el = readerRef.current
    if (!el) return
    let lock = 0
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault()
        const cur = s.settings?.readerFontSize ?? 18
        const dir = e.deltaY < 0 ? 1 : -1
        const next = Math.max(12, Math.min(32, cur + dir))
        if (next !== cur) void s.updateSettings({ readerFontSize: next })
        return
      }
      // 只在正文浮层内翻页，避免在侧栏/面板里误触发
      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      if (!inside) return
      e.preventDefault()
      if (Math.abs(e.deltaY) < 2) return
      const now = Date.now()
      if (now - lock < 240) return // 冷却：一次滚动只翻一页
      lock = now
      turnPage(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [turnPage, s.settings?.readerFontSize, s.updateSettings])

  // 追踪可见段落并每 5 秒本地保存
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!book) return
      const { chapter: c, para: p, context } = saveRef.current
      const percent = meta.length ? (c + Math.min(1, (p + 1) / Math.max(chapter?.paragraphs.length ?? 1, 1))) / meta.length : 0
      await window.reader.saveProgress({
        bookId,
        chapterIdx: c,
        paraIdx: p,
        charOffset: 0,
        context,
        percent,
        updatedAt: Date.now()
      })
    }, 5000)
    return (): void => clearInterval(timer)
  }, [bookId, book, meta, chapter])

  // 追踪可见段落：IntersectionObserver 增量回调，替代原 onScroll 里
  // 每次滚动 querySelectorAll 全量遍历 + 逐段 getBoundingClientRect（大章节掉帧根因）。
  // 段落变化时才 setParaIdx（React 同值 bail out 兜底）并同步 5 秒保存所需的锚点。
  useEffect(() => {
    if (!chapter || !bodyRef.current) return
    const root = bodyRef.current
    const io = new IntersectionObserver(
      (entries) => {
        let best: { pidx: number; top: number } | null = null
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const pidx = Number((e.target as HTMLElement).dataset.pidx ?? 0)
          if (best === null || e.boundingClientRect.top < best.top) best = { pidx, top: e.boundingClientRect.top }
        }
        if (best) {
          setParaIdx(best.pidx)
          const text = chapter.paragraphs[best.pidx] ?? ''
          saveRef.current = { chapter: chapterIdx, para: best.pidx, context: text.slice(0, 24) }
        }
      },
      { root, threshold: 0 }
    )
    root.querySelectorAll('[data-pidx]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [chapter, chapterIdx])

  // 显示层简繁：正文仍以原始字符入库，仅渲染/选区按转换后的文本处理
  const script: ScriptMode = s.settings?.readerScript ?? 'original'
  const dispParas = useMemo(() => convertParas(chapter?.paragraphs ?? [], script), [chapter, script])

  // 选区 → 浮动工具条
  const onMouseUp = useCallback((): void => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !bodyRef.current) {
      setToolbar(null)
      return
    }
    const node = sel.anchorNode
    const el = node?.parentElement?.closest('[data-pidx]') as HTMLElement | null
    if (!el || !bodyRef.current.contains(el)) {
      setToolbar(null)
      return
    }
    const pidx = Number(el.dataset.pidx)
    const text = sel.toString().trim()
    if (!text) return
    // 偏移按「显示文本」计算：开启简繁转换后 DOM 里是转换后的字，与 dispParas 对齐
    const para = dispParas[pidx] ?? ''
    // 跨段选择时 indexOf 找不到整串（含换行）会返回 -1，曾把偏移错误记为 0+len；
    // 找不到时保守锚定整段（0 ~ 段长），不产生错误区间。
    const found = para.indexOf(sel.toString())
    const startOffset = Math.max(0, found)
    const endOffset = found >= 0 ? found + text.length : para.length
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 8 })
    setSelection({
      chapterIdx,
      paraIdx: pidx,
      startOffset,
      endOffset,
      text,
      prevContext: dispParas[pidx - 1] ?? '',
      nextContext: dispParas[pidx + 1] ?? ''
    })
  }, [dispParas, chapterIdx])

  const annotationParas = useMemo(() => {
    const m = new Map<number, Annotation[]>()
    annotations.forEach((a) => {
      if (a.chapterIdx !== chapterIdx) return
      m.set(a.paraIdx, [...(m.get(a.paraIdx) ?? []), a])
    })
    return m
  }, [annotations, chapterIdx])

  // 开启隐身时，收起暴露书籍结构的目录面板
  useEffect(() => {
    if (s.stealth) setPanel((p) => (p === 'toc' ? null : p))
  }, [s.stealth])

  if (!book) return <div className="loading">载入中…</div>

  const stealth = s.stealth
  const fontSize = s.settings?.readerFontSize ?? 18
  const lineHeight = s.settings?.readerLineHeight ?? 1.8
  const fontFamily =
    s.settings?.readerFontFamily === 'sans'
      ? '"Microsoft YaHei", "PingFang SC", sans-serif'
      : s.settings?.readerFontFamily === 'mono'
        ? 'Consolas, "Courier New", monospace'
        : '"Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, serif'

  return (
    <div className="reader" ref={readerRef} style={{ fontSize, lineHeight, fontFamily }}>
      <div className="reader-head">
        <button className="btn-link" onClick={() => s.setView('library')}>
          {stealth ? '← 返回' : '← 书库'}
        </button>
        <span className="reader-title">{stealth ? s.settings?.neutralTitle || '文档' : book.title}</span>
        {!stealth && (
          <span className="dim small">
            {meta[chapterIdx]?.title ?? ''} · {Math.round(((chapterIdx + 1) / Math.max(meta.length, 1)) * 100)}%
          </span>
        )}
        <div className="reader-tools">
          <button className={panel === 'toc' ? 'on' : ''} onClick={() => setPanel(panel === 'toc' ? null : 'toc')} title={stealth ? '大纲' : '目录'}>
            {stealth ? '大纲' : '目录'}
          </button>
          <button className={panel === 'notes' ? 'on' : ''} onClick={() => setPanel(panel === 'notes' ? null : 'notes')} title={stealth ? '笔记' : '批注与书签'}>
            笔记
          </button>
          <button className={panel === 'search' ? 'on' : ''} onClick={() => setPanel(panel === 'search' ? null : 'search')} title={stealth ? '搜索' : '本书搜索'}>
            搜索
          </button>
          <button onClick={() => window.reader.addBookmark(bookId, chapterIdx, paraIdx, (chapter?.paragraphs[paraIdx] ?? '').slice(0, 20)).then(refreshSide)}>
            {stealth ? '标记' : '加书签'}
          </button>
          <select
            value={s.settings?.readerTheme}
            onChange={(e) => {
              s.updateSettings({ readerTheme: e.target.value as 'light' | 'sepia' | 'dark' })
              s.setTheme(e.target.value)
            }}
          >
            <option value="light">浅色</option>
            <option value="sepia">{stealth ? '柔和' : '护眼'}</option>
            <option value="dark">深色</option>
          </select>
          <button
            className={script === 'original' ? '' : 'on'}
            onClick={() => s.updateSettings({ readerScript: nextScript(script) })}
            title="简繁切换（仅改显示，正文原文与书签/批注/进度不受影响）：原文 → 简体 → 繁体"
          >
            {SCRIPT_LABEL[script]}
          </button>
          <button onClick={() => s.updateSettings({ readerFontSize: Math.min(32, fontSize + 1) })}>A＋</button>
          <button onClick={() => s.updateSettings({ readerFontSize: Math.max(12, fontSize - 1) })}>A－</button>
          <button
            onClick={() => s.updateSettings({ readerWidth: Math.max(480, (s.settings?.readerWidth ?? 820) - 60) })}
            title="缩窄正文栏"
          >
            ⇤栏
          </button>
          <button
            onClick={() => s.updateSettings({ readerWidth: Math.min(1100, (s.settings?.readerWidth ?? 820) + 60) })}
            title="加宽正文栏"
          >
            栏⇥
          </button>
          <button className={s.quickOpen ? 'on' : ''} onClick={() => s.toggleQuick()} title="快速调节面板（Ctrl+,）">
            ⚙
          </button>
          <button className="hide-btn" onClick={() => window.reader.hide()}>
            隐藏
          </button>
        </div>
      </div>

      <div className="reader-main">
        <div className="reader-body" ref={bodyRef} onMouseUp={onMouseUp}>
          {chapter?.error === 'content-unreadable' ? (
            <div className="empty-state">正文无法解密读取（PIN 曾被重置，或本机安全存储环境变化）。可删除该书并从源文件重新导入。</div>
          ) : chapter ? (
            <>
              {!stealth && <h3 className="chapter-title">{convertText(chapter.title, script)}</h3>}
              {dispParas.map((p, i) => (
                <p
                  key={i}
                  data-pidx={i}
                  className={annotationParas.has(i) ? 'annotated' : undefined}
                  title={annotationParas.get(i)?.map((a) => a.note).join('\n')}
                >
                  {p}
                </p>
              ))}
              <div className="chapter-nav">
                <button disabled={chapterIdx === 0} onClick={() => setChapterIdx(chapterIdx - 1)}>
                  {stealth ? '← 上一页' : '← 上一章'}
                </button>
                <button disabled={chapterIdx >= meta.length - 1} onClick={() => setChapterIdx(chapterIdx + 1)}>
                  {stealth ? '下一页 →' : '下一章 →'}
                </button>
              </div>
            </>
          ) : (
            <div className="loading">读取章节…</div>
          )}
        </div>

        {panel === 'toc' && (
          <aside className="side-panel">
            <h4>{stealth ? `大纲（${meta.length} 节）` : `目录（${meta.length} 章）`}</h4>
            <div className="toc-list">
              {meta.map((m) => (
                <button key={m.idx} className={m.idx === chapterIdx ? 'on' : ''} onClick={() => setChapterIdx(m.idx)}>
                  {m.title}
                </button>
              ))}
            </div>
          </aside>
        )}

        {panel === 'notes' && (
          <aside className="side-panel">
            <h4>书签</h4>
            {bookmarks.map((b) => (
              <div key={b.id} className="note-item">
                <button
                  className="note-link"
                  onClick={() => {
                    setChapterIdx(b.chapterIdx)
                    setTimeout(() => bodyRef.current?.querySelector(`[data-pidx="${b.paraIdx}"]`)?.scrollIntoView(), 300)
                  }}
                >
                  {meta[b.chapterIdx]?.title ?? `第${b.chapterIdx + 1}章`} · {b.label.slice(0, 18) || '书签'}
                </button>
                <button className="mini" onClick={() => window.reader.removeBookmark(b.id).then(refreshSide)}>
                  ×
                </button>
              </div>
            ))}
            <h4>批注</h4>
            {annotations.map((a) => (
              <div
                key={a.id}
                className="note-item ann"
                onClick={() => {
                  setChapterIdx(a.chapterIdx)
                  setTimeout(() => bodyRef.current?.querySelector(`[data-pidx="${a.paraIdx}"]`)?.scrollIntoView(), 300)
                }}
              >
                <div className="ann-quote">「{a.excerpt.slice(0, 30)}」</div>
                <textarea
                  value={a.note}
                  placeholder="写点想法…"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => window.reader.updateAnnotation(a.id, e.target.value).then(refreshSide)}
                />
                <button className="mini" onClick={(e) => void (e.stopPropagation(), window.reader.removeAnnotation(a.id).then(refreshSide))}>
                  删除
                </button>
              </div>
            ))}
            {annotations.length === 0 && bookmarks.length === 0 && <div className="dim small">在正文中选中文字即可划线、批注或请求 AI 辅助。</div>}
          </aside>
        )}

        {panel === 'search' && (
          <aside className="side-panel">
            <div className="row">
              <input value={searchQ} placeholder={stealth ? '搜索内容' : '本书全文搜索'} onChange={(e) => setSearchQ(e.target.value)} />
              <button
                onClick={async () => {
                  const r = await window.reader.search(searchQ, bookId)
                  setHits(r as never)
                }}
              >
                搜索
              </button>
            </div>
            {(hits as Array<{ chapterIdx: number; paraIdx: number; snippet: string }>).map((h, i) => (
              <div
                key={i}
                className="hit"
                onClick={() => {
                  setChapterIdx(h.chapterIdx)
                  setTimeout(() => bodyRef.current?.querySelector(`[data-pidx="${h.paraIdx}"]`)?.scrollIntoView({ block: 'center' }), 300)
                }}
              >
                {h.snippet.slice(0, 60)}
              </div>
            ))}
          </aside>
        )}

        {panel === 'ai' && selection && (
          <AiPanel
            bookId={bookId}
            contentVersion={book.contentVersion}
            language={book.language}
            selection={selection}
            onClose={() => setPanel(null)}
            onSaveNote={(note) => {
              window.reader
                .addAnnotation({
                  bookId,
                  chapterIdx: selection.chapterIdx,
                  paraIdx: selection.paraIdx,
                  startOffset: selection.startOffset,
                  endOffset: selection.endOffset,
                  excerpt: selection.text,
                  note
                })
                .then(refreshSide)
            }}
          />
        )}
      </div>

      {toolbar && selection && panel !== 'ai' && (
        <div className="sel-toolbar" style={{ left: toolbar.x, top: toolbar.y }}>
          <button
            onClick={() => {
              window.reader
                .addAnnotation({
                  bookId,
                  chapterIdx: selection.chapterIdx,
                  paraIdx: selection.paraIdx,
                  startOffset: selection.startOffset,
                  endOffset: selection.endOffset,
                  excerpt: selection.text,
                  note: ''
                })
                .then(() => {
                  refreshSide()
                  setToolbar(null)
                })
            }}
          >
            划线
          </button>
          <button
            onClick={() => {
              setSelection({ ...selection, task: 'translate' })
              setPanel('ai')
              setToolbar(null)
            }}
          >
            翻译
          </button>
          <button
            onClick={async () => {
              await window.reader.addAnnotation({
                bookId,
                chapterIdx: selection.chapterIdx,
                paraIdx: selection.paraIdx,
                startOffset: selection.startOffset,
                endOffset: selection.endOffset,
                excerpt: selection.text,
                note: '【批注】'
              })
              refreshSide()
              setPanel('notes')
              setToolbar(null)
            }}
          >
            批注
          </button>
          <button
            onClick={() => {
              setSelection({ ...selection, task: 'explain' })
              setPanel('ai')
              setToolbar(null)
            }}
          >
            解释
          </button>
        </div>
      )}
      {stealth && (
        <>
          <div className="focus-hotzone" />
          <div className="focus-bar">
            <span className="focus-drag" title="拖动窗口（整块文字均可拖动）" />
            <button className={s.quickOpen ? 'on' : ''} onClick={() => s.toggleQuick()} title="快速调节（Ctrl+,）：透明度、明暗、配色、字号、栏宽、栏高、置顶">
              ⚙ 调节
            </button>
            <button className="hide-btn" onClick={() => void window.reader.hideToTray()} title="隐藏到托盘（也可连按两下 Esc）；点托盘图标恢复">
              隐藏
            </button>
            <button onClick={() => void s.toggleStealth()} title="退出专注">
              退出专注
            </button>
          </div>
        </>
      )}
    </div>
  )
}
