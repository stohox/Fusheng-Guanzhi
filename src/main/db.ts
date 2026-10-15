import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import initSqlJs, { Database } from 'sql.js'
import { encryptText, decryptText } from './crypto'
import type {
  Book,
  Library,
  Tag,
  Chapter,
  Bookmark,
  Annotation,
  ReadingProgress,
  SearchHit,
  ClassificationSuggestion
} from '../shared/types'

let db: Database | null = null
let saveTimer: NodeJS.Timeout | null = null

const dbPath = (): string => path.join(app.getPath('userData'), 'reader.db')

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f)
  })
  const p = dbPath()
  const existing = fs.existsSync(p) ? fs.readFileSync(p) : null
  if (existing) {
    try {
      db = new SQL.Database(existing)
    } catch {
      // 主库损坏（历史上非原子写中断等）：损坏文件改名保留，尝试从 .bak 恢复
      console.warn('[db] reader.db 损坏，尝试从 reader.db.bak 恢复')
      let recovered: Database | null = null
      try {
        fs.copyFileSync(p, p + '.corrupt.' + Date.now())
        if (fs.existsSync(p + '.bak')) {
          recovered = new SQL.Database(fs.readFileSync(p + '.bak'))
          fs.copyFileSync(p + '.bak', p)
        }
      } catch {
        recovered = null
      }
      db = recovered ?? new SQL.Database()
    }
  } else {
    db = new SQL.Database()
  }
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, author TEXT DEFAULT '', language TEXT DEFAULT 'zh',
      format TEXT DEFAULT 'txt', source TEXT DEFAULT '',
      integrity TEXT DEFAULT 'complete', content_version INTEGER DEFAULT 1,
      fingerprint TEXT DEFAULT '', word_count INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
      locked_fields TEXT DEFAULT '[]', suggestion TEXT
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL, idx INTEGER NOT NULL, title TEXT DEFAULT '',
      content TEXT NOT NULL, encrypted INTEGER DEFAULT 0, word_count INTEGER DEFAULT 0,
      UNIQUE(book_id, idx)
    );
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      is_private INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_library (
      book_id INTEGER NOT NULL, library_id INTEGER NOT NULL, suggested INTEGER DEFAULT 0,
      PRIMARY KEY (book_id, library_id)
    );
    CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS book_tag (book_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, suggested INTEGER DEFAULT 0,
      PRIMARY KEY (book_id, tag_id));
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER, chapter_idx INTEGER, para_idx INTEGER,
      label TEXT DEFAULT '', created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER, chapter_idx INTEGER, para_idx INTEGER,
      start_offset INTEGER DEFAULT 0, end_offset INTEGER DEFAULT 0,
      excerpt TEXT DEFAULT '', note TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS progress (
      book_id INTEGER PRIMARY KEY, chapter_idx INTEGER DEFAULT 0, para_idx INTEGER DEFAULT 0,
      char_offset INTEGER DEFAULT 0, context TEXT DEFAULT '', percent REAL DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, field TEXT, value TEXT,
      library_id INTEGER, priority INTEGER DEFAULT 100
    );
    CREATE TABLE IF NOT EXISTS ai_cache (
      key TEXT PRIMARY KEY, task TEXT, result TEXT, model TEXT, tokens INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS search_fts (
      book_id INTEGER, chapter_idx INTEGER, para_idx INTEGER, text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
    CREATE INDEX IF NOT EXISTS idx_search_book ON search_fts(book_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);
  `)
  persistNow()
}

function must(): Database {
  if (!db) throw new Error('db not initialized')
  return db
}

export function persist(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow()
  }, 400)
}

export function persistNow(): void {
  if (!db) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const data = Buffer.from(db.export())
  const p = dbPath()
  const tmp = p + '.tmp'
  // 原子写：先落临时文件，保留上一份为 .bak，再 rename 替换。
  // 直接覆盖写一旦中途崩溃/断电会产生半截库文件，导致整库无法打开。
  fs.writeFileSync(tmp, data)
  try {
    fs.copyFileSync(p, p + '.bak')
  } catch {
    /* 首次运行尚无主库，跳过备份 */
  }
  fs.renameSync(tmp, p)
}

// ---------------- 通用查询辅助 ----------------
function all<T>(sql: string, params: unknown[], map: (r: Record<string, unknown>) => T): T[] {
  const stmt = must().prepare(sql)
  if (params.length) stmt.bind(params as never)
  const out: T[] = []
  while (stmt.step()) out.push(map(stmt.getAsObject() as Record<string, unknown>))
  stmt.free()
  return out
}

function get<T>(sql: string, params: unknown[], map: (r: Record<string, unknown>) => T): T | null {
  const rows = all(sql, params, map)
  return rows.length ? rows[0] : null
}

function run(sql: string, params?: unknown[]): number {
  must().run(sql, params as never)
  const r = must().exec("SELECT last_insert_rowid() AS id")
  persist()
  return (r[0]?.values[0]?.[0] as number) ?? 0
}

const n = (v: unknown): number => Number(v ?? 0)
const s = (v: unknown): string => String(v ?? '')

function mapBook(r: Record<string, unknown>): Book {
  return {
    id: n(r.id), title: s(r.title), author: s(r.author), language: s(r.language),
    format: s(r.format), source: s(r.source), integrity: s(r.integrity) as Book['integrity'],
    contentVersion: n(r.content_version), fingerprint: s(r.fingerprint), wordCount: n(r.word_count),
    chapterCount: n(r.chapter_count), createdAt: n(r.created_at), updatedAt: n(r.updated_at),
    deletedAt: r.deleted_at == null ? null : n(r.deleted_at),
    lockedFields: safeJsonArray(s(r.locked_fields)),
    suggestion: r.suggestion ? (JSON.parse(String(r.suggestion)) as ClassificationSuggestion) : null
  }
}

function safeJsonArray(t: string): string[] {
  try {
    const v = JSON.parse(t || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export const books = {
  list(includeDeleted = false): Book[] {
    return all(
      `SELECT b.*, (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count FROM books b
       ${includeDeleted ? '' : 'WHERE b.deleted_at IS NULL'} ORDER BY b.updated_at DESC`,
      [],
      mapBook
    )
  },
  get(id: number): Book | null {
    return get(
      `SELECT b.*, (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count FROM books b WHERE b.id=?`,
      [id],
      mapBook
    )
  },
  byFingerprint(fp: string): Book[] {
    return all(`SELECT * FROM books WHERE fingerprint=? AND deleted_at IS NULL`, [fp], mapBook)
  },
  bySource(source: string): Book[] {
    return all(`SELECT * FROM books WHERE source=? AND deleted_at IS NULL`, [source], mapBook)
  },
  create(b: Partial<Book>): number {
    const now = Date.now()
    return run(
      `INSERT INTO books(title,author,language,format,source,integrity,content_version,fingerprint,word_count,created_at,updated_at,locked_fields,suggestion)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      [
        b.title ?? '未命名', b.author ?? '', b.language ?? 'zh', b.format ?? 'txt', b.source ?? '',
        b.integrity ?? 'complete', b.contentVersion ?? 1, b.fingerprint ?? '', b.wordCount ?? 0,
        now, now, JSON.stringify(b.lockedFields ?? []), b.suggestion ? JSON.stringify(b.suggestion) : null
      ]
    )
  },
  update(id: number, patch: Partial<Book>): void {
    const sets: string[] = []
    const params: unknown[] = []
    const put = (col: string, v: unknown) => {
      sets.push(`${col}=?`)
      params.push(v)
    }
    if (patch.title !== undefined) put('title', patch.title)
    if (patch.author !== undefined) put('author', patch.author)
    if (patch.language !== undefined) put('language', patch.language)
    if (patch.integrity !== undefined) put('integrity', patch.integrity)
    if (patch.contentVersion !== undefined) put('content_version', patch.contentVersion)
    if (patch.lockedFields !== undefined) put('locked_fields', JSON.stringify(patch.lockedFields))
    if (patch.suggestion !== undefined)
      put('suggestion', patch.suggestion ? JSON.stringify(patch.suggestion) : null)
    if (patch.deletedAt !== undefined) put('deleted_at', patch.deletedAt)
    put('updated_at', Date.now())
    params.push(id)
    must().run(`UPDATE books SET ${sets.join(',')} WHERE id=?`, params as never)
    persist()
  },
  // 回收站保留 30 天：仅物理清除删除超过 30 天的条目（与 UI 承诺一致）
  purgeDeleted(): void {
    const cutoff = Date.now() - 30 * 86400_000
    const rows = all(
      `SELECT id FROM books WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
      [cutoff],
      (r) => n(r.id)
    )
    for (const id of rows) books.purge(id)
  },
  purge(id: number): void {
    // 事务包裹：任一 DELETE 失败时整体回滚，不留孤儿数据
    must().run('BEGIN TRANSACTION')
    try {
      must().run(`DELETE FROM chapters WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM book_library WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM book_tag WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM bookmarks WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM annotations WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM progress WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM search_fts WHERE book_id=?`, [id] as never)
      must().run(`DELETE FROM books WHERE id=?`, [id] as never)
      must().run('COMMIT')
    } catch (e) {
      must().run('ROLLBACK')
      throw e
    }
    persistNow()
  }
}

// ---------------- Chapters ----------------
export const chapters = {
  meta(bookId: number): { idx: number; title: string; wordCount: number }[] {
    return all(
      `SELECT idx,title,word_count FROM chapters WHERE book_id=? ORDER BY idx`,
      [bookId],
      (r) => ({ idx: n(r.idx), title: s(r.title), wordCount: n(r.word_count) })
    )
  },
  get(bookId: number, idx: number): Chapter | null {
    return get(
      `SELECT id,book_id,idx,title,content,encrypted,word_count FROM chapters WHERE book_id=? AND idx=?`,
      [bookId, idx],
      (r) => ({
        id: n(r.id), bookId: n(r.book_id), idx: n(r.idx), title: s(r.title),
        wordCount: n(r.word_count), paragraphs: [], encrypted: n(r.encrypted) === 1,
        raw: s(r.content)
      } as unknown as Chapter)
    )
  },
  insertAll(bookId: number, list: { title: string; paragraphs: string[]; encrypted?: boolean }[], keyBytes?: Buffer): void {
    must().run('BEGIN TRANSACTION')
    try {
      for (let i = 0; i < list.length; i++) {
        const c = list[i]
        const json = JSON.stringify(c.paragraphs)
        const content = c.encrypted && keyBytes ? encryptText(json, keyBytes) : json
        must().run(
          `INSERT OR REPLACE INTO chapters(book_id,idx,title,content,encrypted,word_count) VALUES(?,?,?,?,?,?)`,
          [bookId, i, c.title, content, c.encrypted && keyBytes ? 1 : 0, c.paragraphs.join('').length] as never
        )
        if (!c.encrypted) indexChapterText(bookId, i, c.paragraphs)
      }
      must().run('COMMIT')
    } catch (e) {
      must().run('ROLLBACK')
      throw e
    }
    persistNow()
  },
  reindex(bookId: number): void {
    must().run(`DELETE FROM search_fts WHERE book_id=?`, [bookId] as never)
    const rows = all(`SELECT idx,content,encrypted FROM chapters WHERE book_id=?`, [bookId], (r) => r)
    for (const r of rows) {
      let paras: string[] = []
      try {
        paras = JSON.parse(n(r.encrypted) ? decryptText(s(r.content)) : s(r.content))
      } catch {
        continue
      }
      indexChapterText(bookId, n(r.idx), paras)
    }
    persistNow()
  }
}

function indexChapterText(bookId: number, idx: number, paras: string[]): void {
  for (let p = 0; p < paras.length; p++) {
    const t = paras[p]
    if (!t) continue
    if (t.length <= 800) {
      must().run(`INSERT INTO search_fts(book_id,chapter_idx,para_idx,text) VALUES(?,?,?,?)`, [
        bookId,
        idx,
        p,
        t
      ] as never)
    } else {
      // 超长段落切片索引，避免搜索语句膨胀
      for (let off = 0; off < t.length; off += 800) {
        must().run(`INSERT INTO search_fts(book_id,chapter_idx,para_idx,text) VALUES(?,?,?,?)`, [
          bookId,
          idx,
          p,
          t.slice(off, off + 800)
        ] as never)
      }
    }
  }
}

// ---------------- Libraries & Tags ----------------
export const libraries = {
  list(): Library[] {
    return all(`SELECT * FROM libraries ORDER BY id`, [], (r) => ({
      id: n(r.id), name: s(r.name), isPrivate: n(r.is_private) === 1, createdAt: n(r.created_at)
    }))
  },
  get(id: number): Library | null {
    return get(`SELECT * FROM libraries WHERE id=?`, [id], (r) => ({
      id: n(r.id), name: s(r.name), isPrivate: n(r.is_private) === 1, createdAt: n(r.created_at)
    }))
  },
  create(name: string, isPrivate: boolean): number {
    return run(`INSERT INTO libraries(name,is_private,created_at) VALUES(?,?,?)`, [
      name,
      isPrivate ? 1 : 0,
      Date.now()
    ])
  },
  rename(id: number, name: string): void {
    must().run(`UPDATE libraries SET name=? WHERE id=?`, [name, id] as never)
    persist()
  },
  remove(id: number): void {
    must().run(`DELETE FROM book_library WHERE library_id=?`, [id] as never)
    must().run(`DELETE FROM libraries WHERE id=?`, [id] as never)
    must().run(`DELETE FROM rules WHERE library_id=?`, [id] as never)
    persist()
  }
}

export const tags = {
  list(): Tag[] {
    return all(`SELECT * FROM tags ORDER BY name`, [], (r) => ({ id: n(r.id), name: s(r.name) }))
  },
  findOrCreate(name: string): number {
    const t = get(`SELECT id FROM tags WHERE name=?`, [name], (r) => n(r.id))
    if (t) return t
    return run(`INSERT INTO tags(name) VALUES(?)`, [name])
  }
}

export const relations = {
  librariesOf(bookId: number): number[] {
    return all(`SELECT library_id FROM book_library WHERE book_id=?`, [bookId], (r) => n(r.library_id))
  },
  tagsOf(bookId: number): Tag[] {
    return all(
      `SELECT t.* FROM tags t JOIN book_tag bt ON t.id=bt.tag_id WHERE bt.book_id=? ORDER BY t.name`,
      [bookId],
      (r) => ({ id: n(r.id), name: s(r.name) })
    )
  },
  setLibraries(bookId: number, libraryIds: number[], suggested = false): void {
    must().run(`DELETE FROM book_library WHERE book_id=? AND suggested=?`, [bookId, suggested ? 1 : 0] as never)
    for (const lid of libraryIds)
      must().run(`INSERT OR IGNORE INTO book_library(book_id,library_id,suggested) VALUES(?,?,?)`, [
        bookId,
        lid,
        suggested ? 1 : 0
      ] as never)
    persist()
  },
  addLibrary(bookId: number, libraryId: number): void {
    must().run(`INSERT OR IGNORE INTO book_library(book_id,library_id,suggested) VALUES(?,?,0)`, [
      bookId,
      libraryId
    ] as never)
    persist()
  },
  removeLibrary(bookId: number, libraryId: number): void {
    must().run(`DELETE FROM book_library WHERE book_id=? AND library_id=?`, [bookId, libraryId] as never)
    persist()
  },
  setTags(bookId: number, tagNames: string[], suggested = false): void {
    must().run(`DELETE FROM book_tag WHERE book_id=? AND suggested=?`, [bookId, suggested ? 1 : 0] as never)
    for (const name of tagNames) {
      const tid = tags.findOrCreate(name)
      must().run(`INSERT OR IGNORE INTO book_tag(book_id,tag_id,suggested) VALUES(?,?,?)`, [
        bookId,
        tid,
        suggested ? 1 : 0
      ] as never)
    }
    persist()
  },
  booksInLibrary(libraryId: number): number[] {
    return all(`SELECT book_id FROM book_library WHERE library_id=?`, [libraryId], (r) => n(r.book_id))
  },
  booksWithTag(tagId: number): number[] {
    return all(`SELECT book_id FROM book_tag WHERE tag_id=?`, [tagId], (r) => n(r.book_id))
  }
}

// ---------------- 阅读状态 ----------------
export const bookmarks = {
  list(bookId?: number): Bookmark[] {
    return all(
      `SELECT * FROM bookmarks ${bookId ? 'WHERE book_id=?' : ''} ORDER BY created_at DESC`,
      bookId ? [bookId] : [],
      (r) => ({
        id: n(r.id), bookId: n(r.book_id), chapterIdx: n(r.chapter_idx), paraIdx: n(r.para_idx),
        label: s(r.label), createdAt: n(r.created_at)
      })
    )
  },
  add(bookId: number, chapterIdx: number, paraIdx: number, label: string): number {
    return run(`INSERT INTO bookmarks(book_id,chapter_idx,para_idx,label,created_at) VALUES(?,?,?,?,?)`, [
      bookId,
      chapterIdx,
      paraIdx,
      label,
      Date.now()
    ])
  },
  remove(id: number): void {
    must().run(`DELETE FROM bookmarks WHERE id=?`, [id] as never)
    persist()
  }
}

export const annotations = {
  list(bookId: number): Annotation[] {
    return all(`SELECT * FROM annotations WHERE book_id=? ORDER BY chapter_idx,para_idx,start_offset`, [bookId], (r) => ({
      id: n(r.id), bookId: n(r.book_id), chapterIdx: n(r.chapter_idx), paraIdx: n(r.para_idx),
      startOffset: n(r.start_offset), endOffset: n(r.end_offset), excerpt: s(r.excerpt), note: s(r.note),
      createdAt: n(r.created_at), updatedAt: n(r.updated_at)
    }))
  },
  add(a: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>): number {
    const now = Date.now()
    return run(
      `INSERT INTO annotations(book_id,chapter_idx,para_idx,start_offset,end_offset,excerpt,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [a.bookId, a.chapterIdx, a.paraIdx, a.startOffset, a.endOffset, a.excerpt, a.note, now, now]
    )
  },
  updateNote(id: number, note: string): void {
    must().run(`UPDATE annotations SET note=?,updated_at=? WHERE id=?`, [note, Date.now(), id] as never)
    persist()
  },
  remove(id: number): void {
    must().run(`DELETE FROM annotations WHERE id=?`, [id] as never)
    persist()
  }
}

export const progress = {
  save(p: ReadingProgress): void {
    must().run(
      `INSERT INTO progress(book_id,chapter_idx,para_idx,char_offset,context,percent,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET chapter_idx=excluded.chapter_idx,para_idx=excluded.para_idx,
       char_offset=excluded.char_offset,context=excluded.context,percent=excluded.percent,updated_at=excluded.updated_at`,
      [p.bookId, p.chapterIdx, p.paraIdx, p.charOffset, p.context, p.percent, p.updatedAt] as never
    )
    persist()
  },
  get(bookId: number): ReadingProgress | null {
    return get(`SELECT * FROM progress WHERE book_id=?`, [bookId], (r) => ({
      bookId: n(r.book_id), chapterIdx: n(r.chapter_idx), paraIdx: n(r.para_idx), charOffset: n(r.char_offset),
      context: s(r.context), percent: n(r.percent), updatedAt: n(r.updated_at)
    }))
  },
  recent(limit = 8): { book: Book; percent: number; updatedAt: number; chapterIdx: number }[] {
    return all(
      `SELECT b.*, p.percent, p.updated_at, p.chapter_idx FROM progress p JOIN books b ON b.id=p.book_id
       WHERE b.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT ?`,
      [limit],
      (r) => ({ book: mapBook(r), percent: n(r.percent), updatedAt: n(r.updated_at), chapterIdx: n(r.chapter_idx) })
    )
  }
}

// ---------------- 规则 ----------------
export const rules = {
  list(): { id: number; field: string; value: string; libraryId: number; priority: number; libraryName: string }[] {
    return all(
      `SELECT r.*, l.name AS lname FROM rules r LEFT JOIN libraries l ON l.id=r.library_id ORDER BY priority`,
      [],
      (r) => ({
        id: n(r.id), field: s(r.field), value: s(r.value), libraryId: n(r.library_id),
        priority: n(r.priority), libraryName: s(r.lname)
      })
    )
  },
  add(field: string, value: string, libraryId: number, priority: number): number {
    return run(`INSERT INTO rules(field,value,library_id,priority) VALUES(?,?,?,?)`, [
      field,
      value,
      libraryId,
      priority
    ])
  },
  remove(id: number): void {
    must().run(`DELETE FROM rules WHERE id=?`, [id] as never)
    persist()
  }
}

// ---------------- AI 缓存 ----------------
export const aiCache = {
  get(key: string): { result: string; tokens: number } | null {
    return get(`SELECT result,tokens FROM ai_cache WHERE key=?`, [key], (r) => ({
      result: s(r.result),
      tokens: n(r.tokens)
    }))
  },
  put(key: string, task: string, result: string, model: string, tokens: number): void {
    must().run(
      `INSERT OR REPLACE INTO ai_cache(key,task,result,model,tokens,created_at) VALUES(?,?,?,?,?,?)`,
      [key, task, result, model, tokens, Date.now()] as never
    )
    persist()
  },
  clear(): void {
    must().run(`DELETE FROM ai_cache`)
    persistNow()
  },
  stats(): { count: number; tokens: number } {
    return get(`SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_cache`, [], (r) => ({
      count: n(r.c),
      tokens: n(r.t)
    })) ?? { count: 0, tokens: 0 }
  }
}

// ---------------- 搜索 ----------------
export function search(query: string, bookId?: number): SearchHit[] {
  if (!query.trim()) return []
  // 注意：反斜杠本身也要转义，否则搜索词含 \ 时在 ESCAPE '\' 语义下结果不准
  const like = `%${query.replace(/[\\%_]/g, (m) => '\\' + m)}%`
  if (bookId) {
    return all(
      `SELECT f.book_id,b.title AS btitle,f.chapter_idx,f.para_idx,f.text FROM search_fts f
       JOIN books b ON b.id=f.book_id WHERE f.book_id=? AND f.text LIKE ? ESCAPE '\\' LIMIT 60`,
      [bookId, like],
      (r) => ({
        bookId: n(r.book_id), bookTitle: s(r.btitle), chapterIdx: n(r.chapter_idx),
        paraIdx: n(r.para_idx), snippet: s(r.text)
      })
    )
  }
  const meta = all(
    `SELECT id AS book_id,title AS btitle,0 AS chapter_idx,0 AS para_idx,'' AS text FROM books
     WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\') LIMIT 30`,
    [like, like],
    (r) => ({
      bookId: n(r.book_id), bookTitle: s(r.btitle), chapterIdx: n(r.chapter_idx),
      paraIdx: n(r.para_idx), snippet: '（书名 / 作者匹配）'
    })
  )
  const full = all(
    `SELECT f.book_id,b.title AS btitle,f.chapter_idx,f.para_idx,f.text FROM search_fts f
     JOIN books b ON b.id=f.book_id WHERE b.deleted_at IS NULL AND f.text LIKE ? ESCAPE '\\' LIMIT 60`,
    [like],
    (r) => ({
      bookId: n(r.book_id), bookTitle: s(r.btitle), chapterIdx: n(r.chapter_idx),
      paraIdx: n(r.para_idx), snippet: s(r.text)
    })
  )
  return [...meta, ...full]
}

// ---------------- 批量关系查询 ----------------
// 一次返回全部（未删除）书籍的书库/标签映射，取代渲染层 N 本书串行 2N 次 IPC 往返
export function booksRelations(): Record<number, { libraries: number[]; tags: string[] }> {
  const out: Record<number, { libraries: number[]; tags: string[] }> = {}
  for (const b of books.list()) out[b.id] = { libraries: [], tags: [] }
  const libRows = all(
    `SELECT bl.book_id AS bid, bl.library_id AS lid FROM book_library bl
     JOIN books b ON b.id=bl.book_id WHERE b.deleted_at IS NULL`,
    [],
    (r) => ({ bid: n(r.bid), lid: n(r.lid) })
  )
  for (const r of libRows) out[r.bid]?.libraries.push(r.lid)
  const tagRows = all(
    `SELECT bt.book_id AS bid, t.name AS name FROM book_tag bt
     JOIN tags t ON t.id=bt.tag_id JOIN books b ON b.id=bt.book_id
     WHERE b.deleted_at IS NULL ORDER BY t.name`,
    [],
    (r) => ({ bid: n(r.bid), name: s(r.name) })
  )
  for (const r of tagRows) out[r.bid]?.tags.push(r.name)
  return out
}

// ---------------- 回收站 ----------------
export const trash = {
  list(): Book[] {
    return all(`SELECT * FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [], mapBook)
  },
  empty(): void {
    const rows = all(`SELECT id FROM books WHERE deleted_at IS NOT NULL`, [], (r) => n(r.id))
    for (const id of rows) books.purge(id)
  }
}
