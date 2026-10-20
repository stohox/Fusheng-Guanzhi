import { ReactNode, useEffect, useState } from 'react'
import { useStore } from '../store'

interface Recent {
  book: { id: number; title: string; author: string; format: string; integrity: string }
  percent: number
  updatedAt: number
  chapterIdx: number
}

export default function ContinueView(): ReactNode {
  const s = useStore()
  const [recent, setRecent] = useState<Recent[]>([])
  const [pending, setPending] = useState<number>(0)

  useEffect(() => {
    window.reader.recentBooks(12).then((r) => setRecent(r as never))
  }, [])

  useEffect(() => {
    setPending(s.books.filter((b) => b.suggestion && b.suggestion.status === 'pending').length)
  }, [s.books])

  return (
    <div className="page">
      <div className="page-head">
        <h2>继续阅读</h2>
        <div className="head-actions">
          <button className="btn-link" onClick={() => s.setView('library')}>
            {pending > 0 ? `待确认分类 ${pending} 项` : '打开书库'}
          </button>
          <button className="btn-primary" onClick={() => s.setView('import')}>
            导入书籍 / 文章
          </button>
        </div>
      </div>
      {recent.length === 0 ? (
        <div className="empty-state">
          <p>还没有阅读记录。</p>
          <p className="dim">从「导入」开始：首期支持本地 TXT / EPUB 文件，导入后即可离线阅读。</p>
        </div>
      ) : (
        <div className="recent-grid">
          {recent.map((r) => (
            <div
              key={r.book.id}
              className="recent-card"
              onClick={() => s.openBook(r.book.id)}
            >
              <div className="rc-title">{r.book.title}</div>
              <div className="rc-meta">
                {r.book.author || '未知作者'} · {r.book.format.toUpperCase()}
                {r.book.integrity === 'partial' && <span className="badge warn">存在缺章</span>}
              </div>
              <div className="rc-bar">
                <div className="rc-fill" style={{ width: `${Math.min(100, Math.round(r.percent * 100))}%` }} />
              </div>
              <div className="rc-sub dim">
                {Math.round(r.percent * 100)}% · {new Date(r.updatedAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
