import { ReactNode, useEffect, useState } from 'react'
import { useStore } from '../store'
import type { ImportTask } from '../../../shared/types'

const STATE_TEXT: Record<string, string> = {
  queued: '排队中',
  parsing: '解析中',
  await_preview: '待确认入库',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  canceled: '已取消'
}

export default function ImportView(): ReactNode {
  const s = useStore()
  const [tasks, setTasks] = useState<Record<string, ImportTask>>({})
  const [manualPath, setManualPath] = useState('')

  useEffect(() => {
    const off = window.reader.on('import:task', (t) => {
      const task = t as unknown as ImportTask
      setTasks((cur) => ({ ...cur, [task.id]: task }))
    })
    return off
  }, [])

  const pick = async (): Promise<void> => {
    const id = await window.reader.pickImport()
    if (id) setTasks((cur) => ({ ...cur, [id]: { id, source: '', state: 'queued', progress: '排队中', preview: null, error: '', bookId: null } }))
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>导入</h2>
      </div>
      <div className="import-entry">
        <button className="btn-primary big" onClick={pick}>
          选择本地文件（TXT / EPUB / Markdown）
        </button>
        <div className="manual-url">
          <input
            value={manualPath}
            placeholder="或粘贴本机文件完整路径，如 D:\\books\\三体.txt"
            onChange={(e) => setManualPath(e.target.value)}
          />
          <button
            onClick={async () => {
              if (!manualPath.trim()) return
              const id = await window.reader.createImport(manualPath.trim())
              setTasks((cur) => ({ ...cur, [id]: { id, source: manualPath, state: 'queued', progress: '排队中', preview: null, error: '', bookId: null } }))
              setManualPath('')
            }}
          >
            解析
          </button>
        </div>
        <p className="dim small">
          首期支持本地文件导入。网页链接与书源适配器为后续阶段；单文件上限 100 MB、最多 5000 章。
        </p>
      </div>

      {Object.values(tasks).map((t) => (
        <div key={t.id} className="task-card">
          <div className="task-head">
            <b>{t.preview?.title ?? t.source.split(/[\\/]/).pop() ?? t.id}</b>
            <span className={`task-state st-${t.state}`}>{STATE_TEXT[t.state]}</span>
            <span className="dim">{t.progress}</span>
          </div>
          {t.error && <div className="task-error">{t.error}（可检查文件后重新选择；不支持的格式会在此说明原因）</div>}
          {(t.state === 'parsing' || t.state === 'queued') && (
            <button className="btn-link" onClick={() => window.reader.cancelImport(t.id, false)}>
              取消
            </button>
          )}
          {t.state === 'await_preview' && t.preview && <PreviewForm task={t} onDone={() => setTasks((cur) => ({ ...cur, [t.id]: { ...t, state: 'done' } }))} />}
          {t.state === 'done' && t.bookId && (
            <button className="btn-link" onClick={() => s.openBook(t.bookId!)}>
              开始阅读 →
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function PreviewForm({ task, onDone }: { task: ImportTask; onDone: () => void }): ReactNode {
  const s = useStore()
  const p = task.preview!
  const [title, setTitle] = useState(p.title)
  const [author, setAuthor] = useState(p.author)
  const [language, setLanguage] = useState(p.language || 'zh')
  const [libraryIds, setLibraryIds] = useState<number[]>([])
  const [privateIds, setPrivateIds] = useState<number[]>([])
  const [tagText, setTagText] = useState('')
  const [dupAction, setDupAction] = useState<'new' | 'open'>('new')

  const toggle = (ids: number[], id: number): number[] => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])

  const confirm = async (): Promise<void> => {
    if (dupAction === 'open' && p.duplicateOf.length) {
      await window.reader.cancelImport(task.id, false) // 释放主进程暂存的解析 Buffer，避免泄漏
      s.openBook(p.duplicateOf[0].id)
      onDone()
      return
    }
    const r = await window.reader.confirmImport({
      taskId: task.id,
      title,
      author,
      language,
      libraryIds,
      privateLibraryIds: privateIds,
      tagNames: tagText.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean),
      duplicateAction: dupAction
    })
    await s.refreshBooks()
    void r
    onDone()
  }

  return (
    <div className="preview">
      {p.duplicateOf.length > 0 && (
        <div className="dup-warn">
          发现相同来源/指纹的内容：{p.duplicateOf.map((d) => d.title).join('、')}
          <div className="dup-actions">
            <label>
              <input type="radio" checked={dupAction === 'open'} onChange={() => setDupAction('open')} /> 打开已有内容
            </label>
            <label>
              <input type="radio" checked={dupAction === 'new'} onChange={() => setDupAction('new')} /> 保留为新版本
            </label>
          </div>
        </div>
      )}
      <div className="form-grid">
        <label>
          书名
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          作者
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label>
          语言
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="zh">中文</option>
            <option value="zh-classical">古文</option>
            <option value="en">英语</option>
            <option value="mixed">混合</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>
          标签（逗号分隔）
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="如：精读, 待整理" />
        </label>
      </div>
      <div className="chapters-summary">
        识别到 <b>{p.chapters.length}</b> 章 · 约 {(p.wordTotal / 10000).toFixed(1)} 万字
        {p.missingChapters && <span className="badge warn">已获取 {p.chapters.length} 个章节，存在缺失</span>}
        {!p.missingChapters && p.integrity === 'complete' && <span className="badge ok">章节完整</span>}
      </div>
      <details className="chapters-list">
        <summary>查看章节列表</summary>
        <ol>
          {p.chapters.slice(0, 200).map((c) => (
            <li key={c.idx}>
              {c.title} <span className="dim">{c.wordCount} 字</span>
            </li>
          ))}
        </ol>
      </details>
      <div className="lib-picker">
        <span className="dim">加入书库：</span>
        {s.libraries.map((l) => (
          <label key={l.id} className={`chip ${libraryIds.includes(l.id) ? 'on' : ''} ${l.isPrivate ? 'private' : ''}`}>
            <input
              type="checkbox"
              checked={libraryIds.includes(l.id)}
              onChange={() => {
                const on = !libraryIds.includes(l.id)
                setLibraryIds(toggle(libraryIds, l.id))
                if (l.isPrivate) setPrivateIds((cur) => (on ? [...cur, l.id] : cur.filter((x) => x !== l.id)))
              }}
            />
            {l.name}
            {l.isPrivate && ' 🔒'}
          </label>
        ))}
        <span className="dim">（未选择将进入「未分类」视图）</span>
      </div>
      <div className="preview-actions">
        <button className="btn-primary" onClick={confirm}>
          确认入库
        </button>
      </div>
      <p className="dim small">入库后会给出分类建议；正文不足或不确定时会留在「未分类」等待人工确认。</p>
    </div>
  )
}
