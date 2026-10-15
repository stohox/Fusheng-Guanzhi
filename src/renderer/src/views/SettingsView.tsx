import { ReactNode, useEffect, useState } from 'react'
import { useStore } from '../store'

export default function SettingsView(): ReactNode {
  const s = useStore()
  const [shortcut, setShortcut] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [conflictMsg, setConflictMsg] = useState('')
  const [pin1, setPin1] = useState('')
  const [pin2, setPin2] = useState('')
  const [pinMsg, setPinMsg] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [stats, setStats] = useState<{ count: number; tokens: number } | null>(null)
  const [neutralText, setNeutralText] = useState('')
  const [neutralTitle, setNeutralTitle] = useState('')

  useEffect(() => {
    if (!s.settings) return
    setShortcut(s.settings.globalShortcut)
    setBaseUrl(s.settings.aiBaseUrl)
    setModel(s.settings.aiModel)
    setNeutralText(s.settings.neutralText)
    setNeutralTitle(s.settings.neutralTitle)
    window.reader.aiStats().then(setStats as never)
  }, [s.settings])

  useEffect(() => {
    if (!capturing) return
    const h = (e: KeyboardEvent): void => {
      e.preventDefault()
      const parts: string[] = []
      if (e.altKey) parts.push('Alt')
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Super')
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
      if (!['Alt', 'Control', 'Shift', 'Meta'].includes(key)) parts.push(key)
      if (parts.length >= 2) {
        setShortcut(parts.join('+'))
        setCapturing(false)
      }
    }
    window.addEventListener('keydown', h, { capture: true })
    return () => window.removeEventListener('keydown', h, { capture: true })
  }, [capturing])

  if (!s.settings) return null
  const st = s.settings

  return (
    <div className="page settings">
      <div className="page-head">
        <h2>设置</h2>
      </div>

      <section>
        <h3>隐私与隐藏</h3>
        <p className="dim small">
          隐私模式用于减少旁观者从应用界面看到阅读内容的机会，不能消除系统记录或既有截屏。以下为可验证的“快速隐藏阅读内容”能力。
        </p>
        <p className="dim small">
          本机加密保护：
          {st.secureStorage
            ? '✅ 正文密钥与 AI 密钥均由系统凭据（Windows DPAPI）保护'
            : '⚠️ 当前系统不支持安全存储，密钥退化为受限文件保存，静态加密强度降低'}
        </p>
        <div className="form-grid">
          <label>
            快捷隐藏键
            <div className="row">
              <input readOnly value={shortcut} style={{ width: 180 }} />
              <button onClick={() => setCapturing(true)}>{capturing ? '按下组合键…' : '修改'}</button>
              <button
                className="btn-primary"
                onClick={async () => {
                  const r = await s.updateSettings({ globalShortcut: shortcut })
                  setConflictMsg(typeof r === 'object' && r?.shortcutConflict ? '全局快捷键注册失败（可能被占用）。应用内快捷键与“隐藏”按钮仍然可用。' : '')
                }}
              >
                应用
              </button>
            </div>
            {conflictMsg && <span className="warn-text">{conflictMsg}</span>}
          </label>
          <label>
            中性窗口标题
            <input value={neutralTitle} onChange={(e) => setNeutralTitle(e.target.value)} onBlur={() => s.updateSettings({ neutralTitle })} />
          </label>
        </div>
        <div className="switch-list">
          <label>
            <input
              type="checkbox"
              checked={st.stealthMode}
              onChange={(e) => s.updateSettings({ stealthMode: e.target.checked })}
            />{' '}
            专注（隐身）模式：阅读时只保留正文文字，其余界面全部隐藏
            <span className="dim small" style={{ display: 'block', marginLeft: 24 }}>
              开启后进入阅读页会自动切换为“只剩文字”的悬浮层：顶栏、书名、章节、进度、工具栏、翻页按钮全部隐去，窗口背景透明、可置顶浮在办公软件之上，文字可半透明不易被察觉。把鼠标移到窗口底部边缘会浮现控制条；快捷键 Alt+Shift+Z 开关、Alt+Shift+↑/↓ 调透明度、Alt+Shift+T 切置顶。
            </span>
          </label>
          {st.stealthMode && (
            <label>
              文字透明度 {Math.round(st.focusOpacity * 100)}%
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={st.focusOpacity}
                onChange={(e) => s.updateSettings({ focusOpacity: Number(e.target.value) })}
              />
            </label>
          )}
          {st.stealthMode && (
            <label>
              <input
                type="checkbox"
                checked={st.focusAlwaysOnTop}
                onChange={(e) => s.updateSettings({ focusAlwaysOnTop: e.target.checked })}
              />{' '}
              专注时窗口置顶（浮在其他程序之上，便于边“工作”边看）
            </label>
          )}
          {st.stealthMode && (
            <label>
              专注文字配色{' '}
              <select value={st.focusTextColor} onChange={(e) => s.updateSettings({ focusTextColor: e.target.value as 'light' | 'dark' })}>
                <option value="light">白字深描边（适合深色桌面 / 代码编辑器）</option>
                <option value="dark">深字白描边（适合白色文档 / 网页）</option>
              </select>
            </label>
          )}
          {st.stealthMode && (
            <label>
              文字明暗 {Math.round(st.focusTextBrightness * 100)}%（描边自动取对比色）
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={st.focusTextBrightness}
                onChange={(e) => s.updateSettings({ focusTextBrightness: Number(e.target.value) })}
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={st.hideOnBlur}
              onChange={(e) => s.updateSettings({ hideOnBlur: e.target.checked })}
            />{' '}
            窗口失焦时隐藏（默认关闭，避免意外干扰）
          </label>
          <label>
            <input
              type="checkbox"
              checked={st.hideOnIdle}
              onChange={(e) => s.updateSettings({ hideOnIdle: e.target.checked })}
            />{' '}
            闲置时隐藏
            <input
              type="number"
              min={1}
              value={st.idleMinutes}
              style={{ width: 60 }}
              onChange={(e) => s.updateSettings({ idleMinutes: Number(e.target.value) || 5 })}
            />{' '}
            分钟
          </label>
          <label>
            <input
              type="checkbox"
              checked={st.lockOnHide}
              onChange={(e) => s.updateSettings({ lockOnHide: e.target.checked })}
            />{' '}
            隐藏后需 PIN 解锁（恢复时不自动显示正文）
          </label>
        </div>
        <details>
          <summary>中性便签文本（隐藏时显示的工作区内容，可填写你自己的中性文字）</summary>
          <textarea value={neutralText} rows={4} onChange={(e) => setNeutralText(e.target.value)} onBlur={() => s.updateSettings({ neutralText })} />
        </details>
        <div className="pin-box">
          {st.hasPin ? (
            <>
              已设置本机 PIN（{st.pinConfigured ? '开启' : '关闭'}）。
              <button
                className="btn-link"
                onClick={async () => {
                  if (window.confirm('重置 PIN 将同时清除隐私书库的受保护正文（无法再解密）。确认？')) {
                    await window.reader.resetPin()
                    await s.updateSettings({})
                  }
                }}
              >
                忘记 PIN / 重置
              </button>
            </>
          ) : (
            <div className="row">
              <input placeholder="4-10 位数字 PIN" value={pin1} onChange={(e) => setPin1(e.target.value.replace(/\D/g, ''))} />
              <input placeholder="再次输入" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
              <button
                onClick={async () => {
                  if (pin1 !== pin2) return setPinMsg('两次输入不一致')
                  const r = await window.reader.setupPin(pin1)
                  setPinMsg(r.ok ? '已设置' : r.error ?? '')
                  await s.updateSettings({})
                }}
              >
                设置 PIN
              </button>
              {pinMsg && <span className="dim">{pinMsg}</span>}
            </div>
          )}
        </div>
      </section>

      <section>
        <h3>AI 服务（古文 / 英语选段辅助）</h3>
        <p className="dim small">
          兼容 OpenAI Chat Completions 接口。请求前明确云端处理范围：默认仅发送所选文本、语言和最多相邻两段，合计不超过 3000 字符。云端 AI 授权独立于同步授权。
        </p>
        <div className="form-grid">
          <label>
            Base URL
            <input value={baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label>
            模型名
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            API Key{st.aiHasKey ? '（已保存；留空则保持不变）' : ''}
            <input type="password" value={apiKey} placeholder={st.aiHasKey ? '••••••••' : 'sk-…'} onChange={(e) => setApiKey(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button
            className="btn-primary"
            onClick={async () => {
              await s.updateSettings({ aiBaseUrl: baseUrl, aiModel: model })
              if (apiKey.trim()) await window.reader.setApiKey(apiKey.trim())
              await s.updateSettings({})
              setApiKey('')
            }}
          >
            保存
          </button>
          <button
            onClick={async () => {
              await window.reader.setApiKey('')
              await s.updateSettings({})
            }}
          >
            清除密钥
          </button>
        </div>
        <div className="usage">
          用量：本机累计 {st.aiUsage.calls} 次调用，约 {st.aiUsage.estTokens.toLocaleString()} token ·
          缓存 {stats?.count ?? 0} 条（{stats?.tokens?.toLocaleString() ?? 0} token）
          <button
            className="btn-link"
            onClick={async () => {
              await window.reader.aiClearCache()
              window.reader.aiStats().then(setStats as never)
            }}
          >
            删除 AI 缓存
          </button>
        </div>
      </section>

      <section>
        <h3>阅读偏好（本机）</h3>
        <p className="dim small">主题、字号与阅读设置按本机保存，不会同步到其他设备，避免他端自动显示正文。</p>
        <div className="form-grid">
          <label>
            默认主题
            <select
              value={st.readerTheme}
              onChange={(e) => {
                s.updateSettings({ readerTheme: e.target.value as 'light' | 'sepia' | 'dark' })
                s.setTheme(e.target.value)
              }}
            >
              <option value="light">浅色</option>
              <option value="sepia">护眼</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            字号 {st.readerFontSize}px
            <input
              type="range"
              min={12}
              max={32}
              value={st.readerFontSize}
              onChange={(e) => s.updateSettings({ readerFontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            行距 {st.readerLineHeight}
            <input
              type="range"
              min={1.2}
              max={2.6}
              step={0.1}
              value={st.readerLineHeight}
              onChange={(e) => s.updateSettings({ readerLineHeight: Number(e.target.value) })}
            />
          </label>
          <label>
            正文栏宽 {st.readerWidth}px
            <input
              type="range"
              min={480}
              max={1100}
              step={20}
              value={st.readerWidth}
              onChange={(e) => s.updateSettings({ readerWidth: Number(e.target.value) })}
            />
          </label>
          <label>
            正文栏高 {st.readerHeight ?? 100}%
            <input
              type="range"
              min={30}
              max={100}
              step={5}
              value={st.readerHeight ?? 100}
              onChange={(e) => s.updateSettings({ readerHeight: Number(e.target.value) })}
            />
          </label>
          <label>
            字体
            <select value={st.readerFontFamily} onChange={(e) => s.updateSettings({ readerFontFamily: e.target.value })}>
              <option value="serif">衬线（宋/明朝体）</option>
              <option value="sans">无衬线（雅黑）</option>
              <option value="mono">等宽</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h3>数据与说明</h3>
        <p className="dim small">
          首期数据仅保存在本机（SQLite + 正文缓存），未登录不同步。隐私书库正文使用平台凭据保护的密钥做静态加密。
          诊断日志不包含书籍正文、书名或完整来源 URL。同步与网页导入接口已预留，将在后续阶段接入。
        </p>
      </section>
    </div>
  )
}
