import crypto from 'crypto'
import { unzipSync } from 'fflate'
import { ClassificationSuggestion, ImportPreview, ImportTask, ImportTaskState, Integrity } from '../shared/types'
import { books, rules, libraries, relations, chapters } from './db'

// ---------------- 文件解析 ----------------

export function decodeText(buf: Buffer): string {
  // 优先 UTF-8（带 BOM 去除），失败尝试 GBK / Big5
  const strip = (s: string) => s.replace(/^\uFEFF/, '')
  for (const enc of ['utf-8', 'gbk', 'big5']) {
    try {
      const td = new TextDecoder(enc, { fatal: enc === 'utf-8' })
      return strip(td.decode(buf))
    } catch {
      continue
    }
  }
  return strip(new TextDecoder('latin1').decode(buf))
}

export function detectLanguage(text: string): string {
  const sample = text.slice(0, 20000)
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (sample.match(/[A-Za-z]/g) || []).length
  const total = Math.max(cjk + latin, 1)
  if (cjk === 0 && latin > 50) return 'en'
  if (cjk / total > 0.85) return isClassical(sample) ? 'zh-classical' : 'zh'
  if (latin / total > 0.85) return 'en'
  return 'mixed'
}

function isClassical(sample: string): boolean {
  const markers = ['之乎者也', '子曰', '诗云', '焉', '哉', '矣', '夫', '惟', '乃', '其']
  let score = 0
  for (const m of markers) if (sample.includes(m)) score++
  return score >= 4
}

const CHAPTER_RE =
  /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*(?:章|节|卷|回|篇|集|部|本|折)|[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\s*\d+|【?序[章言号]?】?|楔子|尾声|后记|前言|目录|End ?Notes?).{0,40}\s*$/

export interface ParsedChapter {
  title: string
  paragraphs: string[]
}

export function parseTxt(text: string, fallbackTitle: string): { title: string; chapters: ParsedChapter[] } {
  const lines = text.split(/\r\n|\n|\r/)
  // 找章节标题行
  const marks: { line: number; title: string }[] = []
  lines.forEach((ln, i) => {
    if (ln.length <= 50 && CHAPTER_RE.test(ln)) marks.push({ line: i, title: ln.trim() })
  })
  const chapters: ParsedChapter[] = []
  const ranges =
    marks.length > 0
      ? marks.map((m, i) => ({ from: m.line, to: i + 1 < marks.length ? marks[i + 1].line : lines.length, title: m.title }))
      : [{ from: 0, to: lines.length, title: '' }]
  for (const r of ranges) {
    const paras = lines
      .slice(r.from + (marks.length > 0 ? 1 : 0), r.to)
      .map((l) => l.trim().replace(/^\u3000+/, ''))
      .filter((l) => l.length > 0)
    if (paras.length === 0 && chapters.length === 0 && !r.title) {
      chapters.push({ title: fallbackTitle, paragraphs: paras })
      continue
    }
    if (paras.length === 0) continue
    // 无章节结构时按 ~8000 字切块
    if (!marks.length && paras.join('').length > 8000) {
      let cur = ''
      let acc: string[] = []
      let part = 1
      for (const p of paras) {
        cur += p
        acc.push(p)
        if (cur.length > 8000) {
          chapters.push({ title: `第 ${part} 部分`, paragraphs: acc })
          acc = []
          cur = ''
          part++
        }
      }
      if (acc.length) chapters.push({ title: `第 ${part} 部分`, paragraphs: acc })
      continue
    }
    chapters.push({ title: r.title || fallbackTitle, paragraphs: paras })
  }
  const title = fallbackTitle
  return { title, chapters: chapters.length ? chapters : [{ title, paragraphs: lines.map((l) => l.trim()).filter(Boolean) }] }
}

// ---------------- EPUB ----------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function htmlToParagraphs(html: string): string[] {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr)>/gi, '\n\n')
  t = t.replace(/<(p|div|h[1-6]|li|blockquote)[^>]*>/gi, '\n\n')
  t = t.replace(/<[^>]+>/g, '')
  t = decodeEntities(t)
  return t
    .split(/\n\s*\n|\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, '\n').trim())
    .filter((p) => p.length > 0)
}

export function parseEpub(
  buf: Buffer,
  fallbackTitle: string
): { title: string; author: string; language: string; chapters: ParsedChapter[]; integrity: Integrity; missing: boolean } {
  const files = unzipSync(new Uint8Array(buf))
  // 解压膨胀检查：MAX_FILE_BYTES 只限压缩后体积，zip bomb 需按解压后总量拦截
  let expanded = 0
  for (const f of Object.values(files)) {
    expanded += f.length
    if (expanded > MAX_EXPANDED_BYTES) {
      throw new Error(`EPUB 解压后超过 ${(MAX_EXPANDED_BYTES / 1048576).toFixed(0)} MB 限制（解压膨胀异常，已拒绝导入）`)
    }
  }
  const dec = (f: Uint8Array): string => decodeText(Buffer.from(f))
  const containerXml = files['META-INF/container.xml'] ? dec(files['META-INF/container.xml']) : ''
  const opfMatch = containerXml.match(/full-path="([^"]+)"/i)
  const opfPath = opfMatch ? opfMatch[1] : Object.keys(files).find((k) => k.endsWith('.opf'))
  if (!opfPath || !files[opfPath]) throw new Error('EPUB 结构不完整：未找到 OPF 包文件')
  const opf = dec(files[opfPath])
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const meta = (tag: string): string => {
    const m = opf.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
    return m ? decodeEntities(m[1]).trim() : ''
  }
  const title = meta('dc:title') || meta('title') || fallbackTitle
  const author = meta('dc:creator') || meta('creator') || ''
  const language = (meta('dc:language') || meta('language') || '').toLowerCase()

  // manifest
  const manifest: Record<string, { href: string; type: string }> = {}
  for (const m of opf.matchAll(/<item\b([^>]*)>/g)) {
    const attrs = m[1]
    const id = /id="([^"]+)"/.exec(attrs)?.[1]
    const href = /href="([^"]+)"/.exec(attrs)?.[1]
    const tp = /media-type="([^"]+)"/.exec(attrs)?.[1] ?? ''
    if (id && href) manifest[id] = { href, type: tp }
  }
  // spine
  const spineIds: string[] = []
  const spineBlock = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i)
  if (spineBlock) {
    for (const m of spineBlock[1].matchAll(/<itemref\b[^>]*idref="([^"]+)"[^>]*>/g)) spineIds.push(m[1])
  }
  // 章节标题映射（nav.xhtml 或 ncx）
  const tocTitles: Record<string, string> = {}
  const tryToc = (xml: string, isNav: boolean) => {
    for (const m of xml.matchAll(/<a[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
      const href = m[1].split('#')[0]
      const label = m[2].replace(/<[^>]+>/g, '').trim()
      if (href && label && !tocTitles[href]) tocTitles[href] = decodeEntities(label)
    }
    if (isNav) return
    for (const m of xml.matchAll(/<navLabel>\s*<text>([^<]*)<\/text>\s*<\/navLabel>\s*<content src="([^"]+)"/g)) {
      const href = m[2].split('#')[0]
      if (href && !tocTitles[href]) tocTitles[href] = decodeEntities(m[1].trim())
    }
  }
  const navId = /<guide|nav\.xhtml/.test(opf) ? Object.keys(files).find((k) => /nav\.x?html?$/i.test(k)) : undefined
  if (navId) tryToc(dec(files[navId]), true)
  const ncxItem = Object.values(manifest).find((m) => /ncx$/i.test(m.href))
  if (ncxItem && files[opfDir + ncxItem.href]) tryToc(dec(files[opfDir + ncxItem.href]), false)

  const chapters: ParsedChapter[] = []
  let missing = false
  for (const id of spineIds) {
    const item = manifest[id]
    if (!item || !/x?-?html/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue
    const key = opfDir + item.href.replace(/^\.\//, '')
    const f = files[key] ?? files[Object.keys(files).find((k) => k.endsWith(item.href.replace(/^\.\//, ''))) ?? '']
    if (!f) {
      missing = true
      continue
    }
    const paras = htmlToParagraphs(dec(f))
    if (paras.length === 0) continue
    const hMatch = dec(f).match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
    const inline = hMatch ? decodeEntities(hMatch[1].replace(/<[^>]+>/g, '')).trim() : ''
    const toc = tocTitles[item.href.replace(/^\.\//, '')] || ''
    chapters.push({ title: inline && !/^(章节|正文|Chapter)$/.test(inline) ? inline : toc || `第 ${chapters.length + 1} 章`, paragraphs: paras })
  }
  if (chapters.length === 0) throw new Error('EPUB 中未解析到可读正文')
  return {
    title,
    author,
    language: language.startsWith('zh') ? 'zh' : language.startsWith('en') ? 'en' : language || 'unknown',
    chapters,
    integrity: missing ? 'partial' : 'complete',
    missing
  }
}

// ---------------- 指纹与去重 ----------------
export function fingerprint(buf: Buffer, name: string): string {
  const h = crypto.createHash('sha256')
  h.update(name)
  h.update(String(buf.length))
  h.update(buf.subarray(0, 64 * 1024))
  return h.digest('hex')
}

export function findDuplicates(fp: string, source: string): { id: number; title: string }[] {
  const seen = new Map<number, { id: number; title: string }>()
  for (const b of books.byFingerprint(fp)) seen.set(b.id, { id: b.id, title: b.title })
  if (source) for (const b of books.bySource(source)) seen.set(b.id, { id: b.id, title: b.title })
  return [...seen.values()]
}

// ---------------- 分类建议 ----------------

const TOPIC_RULES: { name: string; keywords: string[]; tag: string }[] = [
  { name: '历史', keywords: ['历史', '王朝', '战争', '考古', '世纪', '史记', '通鉴', '帝国', '革命'], tag: '历史' },
  { name: '哲学', keywords: ['哲学', '伦理', '存在', '理性', '道德', '形而上', '认知', '思想史'], tag: '哲学' },
  { name: '科技', keywords: ['算法', '编程', '物理', '化学', '生物', '人工智能', '计算机', '工程', '数学'], tag: '科技' },
  { name: '文学', keywords: ['小说', '诗歌', '散文', '故事', '爱情', '命运', '童年', '故乡'], tag: '文学' }
]

export function suggestClassification(
  title: string,
  author: string,
  language: string,
  textSample: string
): ClassificationSuggestion {
  // 1) 用户规则优先（作者 / 书名关键词 / 语言 / 来源）
  let rulesList: ReturnType<typeof rules.list> = []
  let libsList: ReturnType<typeof libraries.list> = []
  try {
    rulesList = rules.list().sort((a, b) => a.priority - b.priority)
    libsList = libraries.list()
  } catch {
    /* 数据层未就绪（如解析预览阶段）：跳过规则匹配 */
  }
  for (const r of rulesList) {
    const hit =
      (r.field === 'author' && author && author.toLowerCase().includes(r.value.toLowerCase())) ||
      (r.field === 'titleKeyword' && title.includes(r.value)) ||
      (r.field === 'language' && language.startsWith(r.value)) ||
      (r.field === 'source' && textSample.includes(r.value))
    if (hit) {
      const lib = libsList.find((l) => l.id === r.libraryId)
      if (lib)
        return {
          libraryId: lib.id,
          libraryName: lib.name,
          tags: [],
          reason: `命中规则：${r.field}=${r.value}`,
          confidence: 1,
          status: 'pending'
        }
    }
  }
  // 2) 元数据 + 正文关键词
  const hay = (title + '\n' + textSample.slice(0, 5000)).toLowerCase()
  let best: { name: string; tag: string; hits: number } | null = null
  for (const t of TOPIC_RULES) {
    const hits = t.keywords.filter((k) => hay.includes(k)).length
    if (!best || hits > best.hits) best = { name: t.name, tag: t.tag, hits }
  }
  const tags: string[] = []
  if (language === 'zh-classical' || isClassical(textSample)) tags.push('古文')
  if (language === 'en' || /英语|英文/.test(hay)) tags.push('英语阅读')
  if (best && best.hits >= 2) {
    const existing = libsList.find((l) => l.name === best!.name)
    return {
      libraryId: existing?.id ?? null,
      libraryName: best.name,
      tags,
      reason: `正文关键词命中 ${best.hits} 项（示例内容判断，可人工修正）`,
      confidence: Math.min(0.6 + best.hits * 0.1, 0.9),
      status: 'pending'
    }
  }
  return { libraryId: null, libraryName: '', tags, reason: '内容不足或主题不明确', confidence: 0, status: 'pending' }
}

// ---------------- 任务队列 ----------------

export type TaskListener = (task: ImportTask) => void

const tasks = new Map<string, ImportTask>()
const parsedStore = new Map<string, { chapters: ParsedChapter[]; buf: Buffer; name: string }>()
let listener: TaskListener | null = null

export function onTaskUpdate(fn: TaskListener): void {
  listener = fn
}

function emit(task: ImportTask): void {
  listener?.(task)
}

function setState(id: string, state: ImportTaskState, progress: string, preview?: ImportPreview | null, error?: string): void {
  const t = tasks.get(id)
  if (!t) return
  if (t.state === 'canceled') return
  t.state = state
  t.progress = progress
  if (preview !== undefined) t.preview = preview
  if (error !== undefined) t.error = error
  emit(t)
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
export const MAX_CHAPTERS = 5000

export function createImportTask(filePath: string): ImportTask {
  const id = crypto.randomUUID()
  const task: ImportTask = { id, source: filePath, state: 'queued', progress: '排队中', preview: null, error: '', bookId: null }
  tasks.set(id, task)
  emit(task)
  setTimeout(() => runParse(id, filePath), 30)
  return task
}

function runParse(id: string, filePath: string): void {
  try {
    setState(id, 'parsing', '读取文件…')
    const fs = require('fs') as typeof import('fs')
    const buf = fs.readFileSync(filePath)
    const name = filePath.split(/[\\/]/).pop() ?? filePath
    if (buf.length > MAX_FILE_BYTES) throw new Error(`文件超过 100 MB 限制（实际 ${(buf.length / 1048576).toFixed(1)} MB）`)
    setState(id, 'parsing', '解析正文…')
    const lower = name.toLowerCase()
    let title = name.replace(/\.[^.]+$/, '')
    let author = ''
    let language = ''
    let chapters: ParsedChapter[]
    let integrity: Integrity = 'complete'
    let missing = false

    if (lower.endsWith('.epub')) {
      const r = parseEpub(buf, title)
      title = r.title
      author = r.author
      language = detectLanguage(chapters0(r.chapters))
      chapters = r.chapters
      integrity = r.integrity
      missing = r.missing
    } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
      const text = decodeText(buf)
      const r = parseTxt(text, title)
      chapters = r.chapters
      language = detectLanguage(text)
    } else {
      throw new Error('暂不支持该格式，首期支持 TXT / EPUB')
    }
    if (chapters.length > MAX_CHAPTERS) chapters = chapters.slice(0, MAX_CHAPTERS)
    const fp = fingerprint(buf, name)
    parsedStore.set(id, { chapters, buf, name })
    const preview: ImportPreview = {
      title,
      author,
      language,
      format: lower.endsWith('.epub') ? 'epub' : 'txt',
      integrity,
      missingChapters: missing,
      fingerprint: fp,
      duplicateOf: findDuplicates(fp, filePath),
      chapters: chapters.map((c, i) => ({ idx: i, title: c.title, wordCount: c.paragraphs.join('').length })),
      wordTotal: chapters.reduce((a, c) => a + c.paragraphs.join('').length, 0)
    }
    setState(id, 'await_preview', '等待确认入库', preview)
  } catch (e) {
    setState(id, 'failed', '失败', null, (e as Error).message)
  }
}

function chapters0(list: ParsedChapter[]): string {
  return list
    .slice(0, 5)
    .map((c) => c.paragraphs.join(''))
    .join('\n')
}

export function cancelTask(id: string, keepPartial: boolean): void {
  const t = tasks.get(id)
  if (!t) return
  t.state = 'canceled'
  t.progress = '已取消'
  emit(t)
  const store = parsedStore.get(id)
  if (store && !keepPartial) parsedStore.delete(id)
}

export interface ConfirmImportPayload {
  taskId: string
  title: string
  author: string
  language: string
  libraryIds: number[]
  tagNames: string[]
  privateLibraryIds: number[] // 属于隐私书库则加密正文
  duplicateAction: 'new' | 'open'
  keyProvider: () => Buffer
}

export function confirmImport(p: ConfirmImportPayload): { bookId: number; suggestion: ClassificationSuggestion } {
  const store = parsedStore.get(p.taskId)
  if (!store) throw new Error('解析结果已过期，请重新导入')
  const sample = chapters0(store.chapters)
  const isPrivate = p.privateLibraryIds.length > 0
  const id = books.create({
    title: p.title,
    author: p.author,
    language: p.language,
    format: p.taskId && store.name.toLowerCase().endsWith('.epub') ? 'epub' : 'txt',
    source: (tasks.get(p.taskId)?.source ?? '').replace(/^\\\\\?\\/, ''),
    integrity: (tasks.get(p.taskId)?.preview?.integrity ?? 'complete') as Integrity,
    fingerprint: p.taskId ? tasks.get(p.taskId)?.preview?.fingerprint ?? '' : '',
    wordCount: store.chapters.reduce((a, c) => a + c.paragraphs.join('').length, 0)
  })
  chaptersPersist(id, store.chapters, isPrivate, p.keyProvider)
  for (const lid of p.libraryIds) relations.addLibrary(id, lid)
  if (p.tagNames.length) relations.setTags(id, p.tagNames)
  const suggestion = suggestClassification(p.title, p.author, p.language, sample)
  if (suggestion.libraryId === null && suggestion.libraryName) {
    // 建议的书库不存在时不自动创建，保留名称供用户确认
  }
  books.update(id, { suggestion })
  const task = tasks.get(p.taskId)
  if (task) {
    task.state = task.preview?.missingChapters ? 'partial' : 'done'
    task.progress = '已入库'
    task.bookId = id
    emit(task)
  }
  parsedStore.delete(p.taskId)
  return { bookId: id, suggestion }
}

function chaptersPersist(bookId: number, list: ParsedChapter[], encrypt: boolean, keyProvider: () => Buffer): void {
  chapters.insertAll(bookId, list.map((c) => ({ title: c.title, paragraphs: c.paragraphs, encrypted: encrypt })), encrypt ? keyProvider() : undefined)
}

export function getTask(id: string): ImportTask | null {
  return tasks.get(id) ?? null
}
