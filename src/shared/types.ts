// 共享类型定义：主进程 / 预加载 / 渲染进程共用

export type BookFormat = 'txt' | 'epub'
export type Integrity = 'complete' | 'partial' | 'link-only'

export interface Book {
  id: number
  title: string
  author: string
  language: string // zh | en | mixed | other
  format: BookFormat | string
  source: string // 文件路径 / URL / ''
  integrity: Integrity
  contentVersion: number
  fingerprint: string
  wordCount: number
  chapterCount: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null // 回收站
  lockedFields: string[] // 人工锁定的维度: 'library' | 'tags' | 'topic' | 'title' ...
  suggestion: ClassificationSuggestion | null
}

export interface ClassificationSuggestion {
  libraryId: number | null
  libraryName: string
  tags: string[]
  reason: string
  confidence: number // 0-1
  status: 'pending' | 'applied' | 'dismissed'
}

export interface Library {
  id: number
  name: string
  isPrivate: boolean // 隐私书库：正文静态加密
  createdAt: number
}

export interface Tag {
  id: number
  name: string
}

export interface Chapter {
  id: number
  bookId: number
  idx: number
  title: string
  wordCount: number
  paragraphs: string[] // 已解密正文
  encrypted?: boolean // 存储层是否为密文
  raw?: string // 存储层原始内容（服务层解密后填充 paragraphs）
  error?: string // 解密失败等状态标记
}

export interface Bookmark {
  id: number
  bookId: number
  chapterIdx: number
  paraIdx: number
  label: string
  createdAt: number
}

export interface Annotation {
  id: number
  bookId: number
  chapterIdx: number
  paraIdx: number
  startOffset: number
  endOffset: number
  excerpt: string
  note: string
  createdAt: number
  updatedAt: number
}

// 位置锚点：内容版本 + 章节 + 段落 + 字符偏移 + 上下文片段（不以页码为唯一位置）
export interface PositionAnchor {
  chapterIdx: number
  paraIdx: number
  charOffset: number
  context: string // 定位用的原文片段
}

export interface ReadingProgress extends PositionAnchor {
  bookId: number
  percent: number
  updatedAt: number
}

export type ImportTaskState = 'queued' | 'parsing' | 'await_preview' | 'done' | 'partial' | 'failed' | 'canceled'

export interface ImportPreview {
  title: string
  author: string
  language: string
  format: string
  integrity: Integrity
  missingChapters: boolean
  fingerprint: string
  duplicateOf: { id: number; title: string }[]
  chapters: { idx: number; title: string; wordCount: number }[]
  wordTotal: number
  error?: string
}

export interface ImportTask {
  id: string
  source: string
  state: ImportTaskState
  progress: string
  preview: ImportPreview | null
  error: string
  bookId: number | null
}

export type AiTaskType = 'translate' | 'explain' | 'qa'

export interface AiRequestPayload {
  requestId: string
  bookId: number
  contentVersion: number
  taskType: AiTaskType
  text: string // 所选文本
  context: string // 相邻段落（最多两段、总长受 3000 字符约束）
  language: string
  targetLanguage: string
  chapterAnchor?: string // 章节:段落:偏移，用于缓存键
  question?: string // taskType=qa 时的问题
}

export interface AiResultPayload {
  requestId: string
  ok: boolean
  canceled?: boolean
  result?: string
  fromCache?: boolean
  error?: string
  usage?: { promptTokens: number; completionTokens: number; estCostNote: string }
}

export interface RuleConfig {
  id: number
  field: 'author' | 'titleKeyword' | 'language' | 'source'
  value: string
  libraryId: number
  priority: number
}

export interface AppSettings {
  // 隐私
  globalShortcut: string
  hideOnBlur: boolean
  hideOnIdle: boolean
  idleMinutes: number
  lockOnHide: boolean
  neutralTitle: string
  neutralText: string
  stealthMode: boolean // 隐身模式：阅读界面去读书化（隐藏书名/封面/章节头、中性化导航与标题）
  focusOpacity: number // 专注悬浮层文字透明度 0.3~1
  focusAlwaysOnTop: boolean // 专注模式下窗口置顶，浮于办公软件之上
  focusTextColor: 'light' | 'dark' // 专注悬浮层文字配色：light=白字深描边（适合深色桌面），dark=深字白描边（适合浅色页面）
  focusTextBrightness: number // 专注文字明暗 0~1（0=黑,1=白），描边自动取对比色
  pinConfigured: boolean
  // AI
  aiBaseUrl: string
  aiModel: string
  aiHasKey: boolean
  aiUsage: { calls: number; estTokens: number }
  // 阅读偏好（本机）
  readerTheme: 'light' | 'sepia' | 'dark'
  readerFontSize: number
  readerLineHeight: number
  readerFontFamily: string
  // 显示层简繁转换：original=按原文；simplified=转简体；traditional=转繁体。正文仍以原始字符入库，仅渲染时转换
  readerScript: 'original' | 'simplified' | 'traditional'
  readerWidth: number // 正文栏最大宽度（px），480~1100，可调阅读列宽
  readerHeight: number // 正文栏高度（占阅读区可用高度的百分比），30~100，专注态垂直居中
  // 状态
  privacyState: 'reading' | 'neutral' | 'locked'
  lastHiddenAt: number | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  globalShortcut: 'Alt+Shift+H',
  hideOnBlur: false,
  hideOnIdle: true,
  idleMinutes: 5,
  lockOnHide: true,
  neutralTitle: '工作笔记',
  neutralText: '',
  stealthMode: false,
  focusOpacity: 1,
  focusAlwaysOnTop: true,
  focusTextColor: 'light',
  focusTextBrightness: 0.96,
  pinConfigured: false,
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiModel: 'deepseek-chat',
  aiHasKey: false,
  aiUsage: { calls: 0, estTokens: 0 },
  readerTheme: 'light',
  readerFontSize: 18,
  readerLineHeight: 1.8,
  readerFontFamily: 'serif',
  readerScript: 'original',
  readerWidth: 820,
  readerHeight: 100,
  privacyState: 'reading',
  lastHiddenAt: null
}

export interface SearchHit {
  bookId: number
  bookTitle: string
  chapterIdx: number
  chapterTitle?: string
  paraIdx: number
  snippet: string
}
