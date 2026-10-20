// 显示层简繁转换工具：正文以原始字符入库，仅渲染时转换，
// 因此书签/批注/搜索/进度锚点（都基于原始段落索引）不受影响。
import { Converter } from 'opencc-js'

export type ScriptMode = 'original' | 'simplified' | 'traditional'

// t → cn（繁体转简体，cn 兼收规范简体写法）；cn → t（简体转繁体）
const toSimplified = Converter({ from: 't', to: 'cn' })
const toTraditional = Converter({ from: 'cn', to: 't' })

// 段落级转换（按段缓存，避免同段重复转换）
const cache = new Map<string, { mode: ScriptMode; out: string }>()

export function convertText(text: string, mode: ScriptMode): string {
  if (mode === 'original' || !text) return text
  const hit = cache.get(text)
  if (hit && hit.mode === mode) return hit.out
  const out = mode === 'simplified' ? toSimplified(text) : toTraditional(text)
  // 简单容量护栏，防止超长全书缓存膨胀
  if (cache.size > 5000) cache.clear()
  cache.set(text, { mode, out })
  return out
}

export function convertParas(paras: string[], mode: ScriptMode): string[] {
  if (mode === 'original') return paras
  return paras.map((p) => convertText(p, mode))
}

export const SCRIPT_LABEL: Record<ScriptMode, string> = {
  original: '原文',
  simplified: '简体',
  traditional: '繁体'
}

// 工具栏按钮：原文 → 简体 → 繁体 → 原文 循环
export function nextScript(mode: ScriptMode): ScriptMode {
  if (mode === 'original') return 'simplified'
  if (mode === 'simplified') return 'traditional'
  return 'original'
}
