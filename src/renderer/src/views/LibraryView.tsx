import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { Book } from '../../../shared/types'

type Scope = { kind: 'all' } | { kind: 'uncategorized' } | { kind: 'pending' } | { kind: 'library'; id: number } | { kind: 'tag'; id: number } | { kind: 'trash' }

export default function LibraryView(): ReactNode {
  const s = useStore()
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bookLibs, setBookLibs] = useState<Record<number, number[]>>({})
  const [bookTags, setBookTags] = useState<Record<number, string[]>>({})
  const [detail, setDetail] = useState<number | null>(null)
  const [showRules, setShowRules] = useState(false)

  useEffect(() => {
    // 一次批量拉全量映射，替代逐书 2 次 IPC 的串行往返（N 本书 2N 次 → 1 次）
    window.reader.booksRelations().then((m) => {
      const l: Record<number, number[]> = {}
      const t: Record<number, string[]> = {}
      for (const [id, v] of Object.entries(m)) {
        l[Number(id)] = v.libraries
        t[Number(id)] = v.tags
      }
      setBookLibs(l)
      setBookTags(t)
    })
  }, [s.books])

  const trashBooks = useMemo(() => [], [])
  void trashBooks

  const visible = useMemo(() => {
    if (scope.kind === 'trash') return []
    const pool = s.books
    switch (scope.kind) {
      case 'all':
        return pool
      case 'uncategorized':
        return pool.filter((b) => (bookLibs[b.id] ?? []).length === 0)
      case 'pending':
        return pool.filter((b) => b.suggestion && b.suggestion.status === 'pending')
      case 'library':
        return pool.filter((b) => (bookLibs[b.id] ?? []).includes(scope.id))
      case 'tag':
        return pool.filter((b) => (bookTags[b.id] ?? []).includes(s.tags.find((t) => t.id === scope.id)?.name ?? ''))
    }
  }, [scope, s.books, bookLibs, bookTags, s.tags])

  const toggleSel = (id: number): void =>
    setSelected((cur) => {
      const n = new Set(cur)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  return (
    <div className="library-layout">
      <aside className="lib-side">
        <SideItem label="全部书籍" active={scope.kind === 'all'} onClick={() => setScope({ kind: 'all' })} />
        <SideItem label="未分类" active={scope.kind === 'uncategorized'} onClick={() => setScope({ kind: 'uncategorized' })} />
        <SideItem
          label="待确认分类"
          badge={s.books.filter((b) => b.suggestion?.status === 'pending').length}
          active={scope.kind === 'pending'}
          onClick={() => setScope({ kind: 'pending' })}
        />
        <div className="side-group">书库</div>
        {s.libraries.map((l) => (
          <SideItem
            key={l.id}
            label={(l.isPrivate ? '🔒 ' : '') + l.name}
            active={scope.kind === 'library' && scope.id === l.id}
            onClick={() => setScope({ kind: 'library', id: l.id })}
            onRename={async (name) => {
              await window.reader.renameLibrary(l.id, name)
              s.refreshLibraries()
            }}
            onDelete={async () => {
              const also = window.confirm(`删除书库「${l.name}」？\n确定=仅解除归属（内容保留在“全部书籍”）；\n取消后再选删除=连同内容进回收站。`)
              await window.reader.removeLibrary(l.id, also)
              s.refreshLibraries()
              s.refreshBooks()
              setScope({ kind: 'all' })
            }}
          />
        ))}
        <NewLibrary onCreated={() => s.refreshLibraries()} />
        <div className="side-group">标签</div>
        {s.tags.map((t) => (
          <SideItem key={t.id} label={'# ' + t.name} active={scope.kind === 'tag' && scope.id === t.id} onClick={() => setScope({ kind: 'tag', id: t.id })} />
        ))}
        <div className="side-group">管理</div>
        <SideItem label="分类规则" active={showRules} onClick={() => setShowRules((v) => !v)} />
        <TrashEntry onCount={() => undefined} />
      </aside>

      <section className="lib-main">
        {showRules && <RulesPanel />}
        {selected.size > 0 && (
          <BulkBar
            ids={[...selected]}
            onDone={() => {
              setSelected(new Set())
              s.refreshBooks()
            }}
          />
        )}
        <div className="book-grid">
          {visible.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              libs={bookLibs[b.id] ?? []}
              tagNames={bookTags[b.id] ?? []}
              selected={selected.has(b.id)}
              onSelect={() => toggleSel(b.id)}
              onOpen={() => s.openBook(b.id)}
              onDetail={() => setDetail(detail === b.id ? null : b.id)}
            />
          ))}
          {visible.length === 0 && <div className="empty-state dim">这里还没有内容。去「导入」添加第一本书吧。</div>}
        </div>
        {detail && <DetailPanel bookId={detail} onClose={() => setDetail(null)} />}
      </section>
    </div>
  )
}

function SideItem({
  label,
  active,
  onClick,
  badge,
  onRename,
  onDelete
}: {
  label: string
  active: boolean
  onClick: () => void
  badge?: number
  onRename?: (name: string) => Promise<void>
  onDelete?: () => Promise<void>
}): ReactNode {
  return (
    <div className={`side-item ${active ? 'on' : ''}`}>
      <button onClick={onClick}>
        {label}
        {badge ? <span className="badge sm">{badge}</span> : null}
      </button>
      {onRename && (
        <button
          className="mini"
          title="重命名"
          onClick={async () => {
            const name = window.prompt('新的书库名称', label.replace('🔒 ', ''))
            if (name) await onRename(name)
          }}
        >
          ✎
        </button>
      )}
      {onDelete && (
        <button className="mini" title="删除书库" onClick={onDelete}>
          ×
        </button>
      )}
    </div>
  )
}

function NewLibrary({ onCreated }: { onCreated: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [priv, setPriv] = useState(false)
  return (
    <div className="new-lib">
      {open ? (
        <div className="new-lib-form">
          <input value={name} placeholder="书库名称" onChange={(e) => setName(e.target.value)} />
          <label>
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> 隐私书库（正文本机加密）
          </label>
          <div className="row">
            <button
              onClick={async () => {
                if (!name.trim()) return
                await window.reader.createLibrary(name.trim(), priv)
                setName('')
                setPriv(false)
                setOpen(false)
                onCreated()
              }}
            >
              创建
            </button>
            <button className="btn-link" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <button className="btn-link" onClick={() => setOpen(true)}>
          ＋ 新建书库
        </button>
      )}
    </div>
  )
}

function BookCard({
  book,
  libs,
  tagNames,
  selected,
  onSelect,
  onOpen,
  onDetail
}: {
  book: Book
  libs: number[]
  tagNames: string[]
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onDetail: () => void
}): ReactNode {
  const s = useStore()
  return (
    <div className={`book-card ${selected ? 'sel' : ''}`}>
      <input type="checkbox" className="card-check" checked={selected} onChange={onSelect} />
      <div className="card-body" onClick={onOpen}>
        <div className="card-title">{book.title}</div>
        <div className="card-meta dim">
          {book.author || '佚名'} · {book.language} · {book.format.toUpperCase()} · {(book.wordCount / 10000).toFixed(1)} 万字
        </div>
        <div className="card-tags">
          {book.integrity === 'partial' && <span className="badge warn">缺章</span>}
          {libs.some((id) => s.libraries.find((l) => l.id === id)?.isPrivate) && <span className="badge lock">加密</span>}
          {tagNames.slice(0, 3).map((t) => (
            <span key={t} className="badge tag">
              {t}
            </span>
          ))}
        </div>
        {book.suggestion && book.suggestion.status === 'pending' && (
          <div className="suggest" onClick={(e) => e.stopPropagation()}>
            建议：{book.suggestion.libraryName || '保持未分类'}
            {book.suggestion.tags.map((t) => ` #${t}`)}
            <div className="dim small">{book.suggestion.reason}（置信 {Math.round(book.suggestion.confidence * 100)}%，需人工确认）</div>
            <div className="row">
              <button
                onClick={async () => {
                  await window.reader.applySuggestion(book.id)
                  s.refreshBooks()
                }}
              >
                采纳
              </button>
              <button
                className="btn-link"
                onClick={async () => {
                  await window.reader.dismissSuggestion(book.id)
                  s.refreshBooks()
                }}
              >
                忽略
              </button>
            </div>
          </div>
        )}
      </div>
      <button className="mini detail" onClick={onDetail}>
        详情
      </button>
    </div>
  )
}

function DetailPanel({ bookId, onClose }: { bookId: number; onClose: () => void }): ReactNode {
  const s = useStore()
  const [libIds, setLibIds] = useState<number[]>([])
  const [tagText, setTagText] = useState('')
  useEffect(() => {
    window.reader.librariesOf(bookId).then((v) => setLibIds(v as never))
    window.reader.tagsOf(bookId).then((v) => setTagText((v as Array<{ name: string }>).map((x) => x.name).join(', ')))
  }, [bookId])
  const book = s.books.find((b) => b.id === bookId)
  return (
    <div className="detail-mask" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <h3>{book?.title}</h3>
        <p className="dim small">
          来源：{book?.source || '本地导入'} · 内容版本 v{book?.contentVersion} · 缓存状态：已缓存 {book?.chapterCount} 章
        </p>
        <label>
          所属书库（修改后自动锁定人工归属）
          <div className="lib-picker">
            {s.libraries.map((l) => (
              <label key={l.id} className={`chip ${libIds.includes(l.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={libIds.includes(l.id)}
                  onChange={() => setLibIds((cur) => (cur.includes(l.id) ? cur.filter((x) => x !== l.id) : [...cur, l.id]))}
                />
                {l.name}
              </label>
            ))}
          </div>
        </label>
        <label>
          标签（逗号分隔）
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} />
        </label>
        {book && (
          <div className="lock-row">
            人工锁定：
            <label>
              <input
                type="checkbox"
                checked={book.lockedFields.includes('library')}
                onChange={async (e) => {
                  await window.reader.lockField(book.id, 'library', e.target.checked)
                  s.refreshBooks()
                }}
              />{' '}
              归属
            </label>
            <label>
              <input
                type="checkbox"
                checked={book.lockedFields.includes('tags')}
                onChange={async (e) => {
                  await window.reader.lockField(book.id, 'tags', e.target.checked)
                  s.refreshBooks()
                }}
              />{' '}
              标签
            </label>
            <span className="dim small">锁定后自动分类不会覆盖该维度</span>
          </div>
        )}
        <div className="row">
          <button
            className="btn-primary"
            onClick={async () => {
              await window.reader.setLibraries(bookId, libIds)
              await window.reader.setTags(
                bookId,
                tagText.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
              )
              s.refreshBooks()
              onClose()
            }}
          >
            保存
          </button>
          <button
            onClick={async () => {
              await window.reader.reanalyze(bookId)
              s.refreshBooks()
            }}
          >
            重新分析（仅未锁定维度）
          </button>
          <button
            className="btn-danger"
            onClick={async () => {
              if (window.confirm('移入回收站？30 天后自动清除，可在回收站恢复。')) {
                await window.reader.deleteBook(bookId)
                s.refreshBooks()
                onClose()
              }
            }}
          >
            删除（进回收站）
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkBar({ ids, onDone }: { ids: number[]; onDone: () => void }): ReactNode {
  const s = useStore()
  const [libId, setLibId] = useState<number>(s.libraries[0]?.id ?? 0)
  return (
    <div className="bulk-bar">
      已选 {ids.length} 项
      <select value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
        {s.libraries.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button
        onClick={async () => {
          for (const id of ids) await relations_add(id)
          onDone()
        }}
      >
        批量移入
      </button>
      <button
        className="btn-danger"
        onClick={async () => {
          if (!window.confirm(`将 ${ids.length} 项内容移入回收站？`)) return
          for (const id of ids) await window.reader.deleteBook(id)
          onDone()
        }}
      >
        批量删除
      </button>
    </div>
  )

  async function relations_add(id: number): Promise<void> {
    await window.reader.setLibraries(id, [...new Set([...(await window.reader.librariesOf(id)), libId])].filter(Boolean) as number[])
  }
}

function RulesPanel(): ReactNode {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof window.reader.listRules>> | null>(null)
  const s = useStore()
  const [field, setField] = useState('author')
  const [value, setValue] = useState('')
  const [libId, setLibId] = useState<number>(s.libraries[0]?.id ?? 0)
  const refresh = (): void => {
    window.reader.listRules().then(setRows as never)
  }
  useEffect(refresh, [])
  return (
    <div className="rules-panel">
      <h4>分类规则（人工锁定 &gt; 规则 &gt; 自动建议，按优先级执行并显示命中原因）</h4>
      <div className="rule-add">
        <select value={field} onChange={(e) => setField(e.target.value)}>
          <option value="author">作者包含</option>
          <option value="titleKeyword">书名关键词</option>
          <option value="language">语言前缀</option>
          <option value="source">来源包含</option>
        </select>
        <input value={value} placeholder="规则值" onChange={(e) => setValue(e.target.value)} />
        <select value={libId} onChange={(e) => setLibId(Number(e.target.value))}>
          {s.libraries.map((l) => (
            <option key={l.id} value={l.id}>
              → {l.name}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            if (!value.trim()) return
            await window.reader.addRule(field, value.trim(), libId, (rows?.length ?? 0) + 1)
            setValue('')
            refresh()
          }}
        >
          添加
        </button>
      </div>
      <ul className="rule-list">
        {(rows ?? []).map((r) => (
          <li key={r.id}>
            #{r.priority} {r.field} = “{r.value}” → {r.libraryName}
            <button className="mini" onClick={async () => void (await window.reader.removeRule(r.id), refresh())}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TrashEntry({ onCount }: { onCount: () => void }): ReactNode {
  void onCount
  const s = useStore()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Book[]>([])
  const load = (): void => {
    window.reader.listTrash().then((v) => setItems(v as never))
  }
  return (
    <div className="trash-entry">
      <button
        className="btn-link"
        onClick={() => {
          setOpen(!open)
          load()
        }}
      >
        回收站
      </button>
      {open && (
        <div className="trash-list">
          {items.map((b) => (
            <div key={b.id} className="trash-item">
              <span className="dim">{b.title}</span>
              <button
                onClick={async () => {
                  await window.reader.restoreBook(b.id)
                  load()
                  s.refreshBooks()
                }}
              >
                恢复
              </button>
            </div>
          ))}
          {items.length === 0 && <div className="dim small">回收站是空的</div>}
          {items.length > 0 && (
            <button
              className="btn-danger"
              onClick={async () => {
                if (window.confirm('清空回收站？此操作不可恢复。')) {
                  await window.reader.emptyTrash()
                  load()
                }
              }}
            >
              清空回收站
            </button>
          )}
        </div>
      )}
    </div>
  )
}
