<div align="center">

<img src="assets/icon.png" width="128" height="128" alt="浮生观止图标" />

# 浮生观止

**本地优先 · 可一键隐藏 · 古籍 / 英语选段辅助的隐私阅读应用（Windows 版）**

[English](README.en.md) · [下载 Releases](https://github.com/stohox/privacy-reader/releases)

</div>

---

浮生观止是一款**数据只存在你本机**的阅读器：导入 TXT / EPUB / Markdown 后即可离线阅读，
支持书库与标签管理、目录跳转、书签与划线批注、阅读进度自动保存、选中段落交给 AI 翻译/解释，
并针对"旁人瞥见"的场景做了**一键隐藏**与**专注悬浮**两套隐私交互。

按《多端隐私阅读应用产品需求文档 v1.0》实现的 Windows 验证版闭环：
导入 → 归类 → 阅读 → 隐藏与恢复 → 批注/进度持久化 → 选段 AI 辅助。

技术路线：**React 18 + TypeScript + Electron**（本机无 Rust，未选 Tauri；桌面隐藏需求由 Electron 窗口/快捷键/托盘承担）。
数据层为 **SQLite（sql.js / WASM）**，正文以「章节—段落—文本」统一模型存储，为后续移动端与同步预留同一核心。

## 界面预览

> 把截图放到 `assets/screenshots/` 即会自动显示（文件名见下）。

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/library.png" width="360" alt="书库"/><br/>书库与标签管理</td>
    <td align="center"><img src="assets/screenshots/reader.png" width="360" alt="阅读器"/><br/>阅读器（目录 / 批注 / AI 面板）</td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/import.png" width="360" alt="导入"/><br/>导入与分类确认</td>
    <td align="center"><img src="assets/screenshots/focus.png" width="360" alt="专注悬浮"/><br/>专注悬浮层（叠在桌面之上）</td>
  </tr>
</table>

## 快速开始

**普通用户 —— 直接下载可执行文件：**

到 [Releases 页面](https://github.com/stohox/privacy-reader/releases) 下载：

- `浮生观止-便携版-x.y.z.exe` —— 免安装单文件，双击即用。
- `浮生观止-安装版-x.y.z.exe` —— 安装向导，可创建桌面 / 开始菜单快捷方式。

> 未做代码签名，首次运行 Windows SmartScreen 会提示"未知发布者"，点"更多信息 → 仍要运行"即可。

**开发者 —— 从源码运行：**

```bash
npm install        # 已配置 npmmirror 镜像
npm run dev        # 开发模式（热更新）
npm run build      # 生产构建到 out/
npm run dist:win   # 打包成可双击运行的 Windows 程序（产物在 dist/）
```

## 使用说明

**导入。** 进入「导入」页，选择本地 TXT / EPUB / Markdown 文件。解析后先出预览：可修改书名、作者、语言、
所属书库与标签，查看章节列表与完整性；系统按"文件名 + 大小 + 首块哈希"去重，命中重复时可选「打开已有」或「保留为新版本」。
确认后入库。分类按"人工锁定 → 用户规则 → 关键词建议"的优先级处理，建议只给理由与置信度、需你确认，不会自动乱动。

**书库与阅读。** 「书库」按书库/标签浏览全部书籍，支持批量移库、删除（回收站 30 天）。
点开任意一本进入阅读器：左侧目录跳转章节，正文支持本书搜索、字号/行距/字体/三主题切换、书签、划线批注（关联到章节+段落+偏移）。
工具栏的「原文 / 简体 / 繁体」按钮可一键切换显示的简繁体——这是**显示层转换**，正文仍以原始字符入库，书签/批注/搜索/进度都不受影响，古籍繁体本可即时读简体、简体本也可转繁体。
阅读进度每 5 秒自动保存到本地；再次打开同一本书（无论从「继续阅读」还是「书库」进入）都会精确回到上次所在的**章节 + 段落**，并按上下文片段重新匹配锚点，改字号/行距或正文更新后依然对得准。

**选段 AI 辅助。** 在阅读器里选中一段文字，右侧 AI 面板可翻译 / 解释 / 提问。默认把所选文本 + 相邻两段（≤3000 字符）发给模型；
结果标注"AI 辅助内容"，可复制、存为笔记、重新生成或取消。接口在「设置」里配置任意 OpenAI 兼容服务（Base URL / Key / 模型），
Key 用系统能力静态加密存放。

**隐私隐藏。** 任何时候按隐藏快捷键（默认 `Alt+Shift+H`），先遮盖正文/书名/笔记/译文/AI 面板，再切到中性"便签"界面；
可设置失焦隐藏、闲置隐藏、隐藏即锁 PIN（PIN 为 scrypt 哈希）。忘记 PIN 只会重置本机锁并清除受保护正文，不影响其它数据。
托盘菜单（右下角）可"显示应用 / 退出"。

**专注悬浮。** 按 `Alt+Shift+Z` 进入专注视图：阅读界面去读书化（隐藏书名、章节头、进度），窗口标题变为中性名，
正文以柔和悬浮层叠在桌面之上；此状态下窗口对桌面**点击穿透**（除正文与控制条外都能点到你桌面上的东西），
底部有控制条，`Ctrl+,` 打开快速调节面板一站式改字号/栏宽/栏高/透明度/明暗/配色/置顶。连按两下 `Esc` 可隐藏到托盘。

## 快捷键一览

| 按键 | 作用 |
|---|---|
| `Alt + Shift + H` | 一键隐藏 / 恢复（全局快捷键，默认值，可在设置里改；冲突时退回应用内快捷键与「隐藏」按钮） |
| `Alt + Shift + Z` | 切换「专注」视图（隐身悬浮层） |
| `Ctrl + ,` | 打开 / 关闭「快速调节」面板（字号、栏宽、栏高、透明度、明暗、配色、置顶） |
| `Esc` | 关闭调节面板；专注态下**连按两下**隐藏到托盘 |
| `空格` / `→` / `↓` / `PgDn` | 阅读器：下一页（到章末自动进下一章） |
| `←` / `↑` / `PgUp` | 阅读器：上一页（到章首自动回上一章） |
| `Home` / `End` | 阅读器：跳到本章开头 / 结尾 |
| 鼠标滚轮 | 阅读器：按屏翻页 |
| `Ctrl` + 滚轮 | 阅读器：缩放字号（12–32） |

## PRD 需求覆盖（P0 · 验证版范围）

| 需求 | 实现 |
|---|---|
| IN01/02 导入与任务状态 | TXT/EPUB/MD 本地导入；任务状态 排队→解析→待预览→完成/部分/失败/取消；100MB/5000 章上限 |
| 4.3 预览与去重 | 入库前可改标题/作者/语言/书库/标签；展示章节列表与完整性；文件名+大小+首块哈希指纹去重 |
| LB01/02 书库与标签 | 多书库多标签（正文单份）、全部内容/未分类视图、批量移库/删除、回收站 30 天 |
| LB03/04 分类 | 优先级 人工锁定→用户规则→关键词建议；建议展示理由与置信度、需人工确认；可重新分析 |
| RD01/02 阅读器 | 目录、章节切换、本书搜索、字号/行距/字体/三主题、简繁显示转换、书签、划线批注；进度每 5 秒本地保存，重开精确回跳章节+段落 |
| 6.1 位置锚点 | 章节+段落+字符偏移+上下文片段定位，跨字号可用；正文更新后按锚点重匹配 |
| PR01-03 隐私 | 全局快捷键隐藏；先遮盖再进中性界面；失焦/闲置隐藏；隐藏即锁 PIN（scrypt）；重启保持遮盖；托盘通用文案 |
| DP01 加密 | 隐私书库正文 AES-256-GCM 静态加密，主密钥经 Windows DPAPI（safeStorage）保护；API Key 同样加密存放 |
| AI01-04 语言辅助 | 设置页配置 OpenAI 兼容接口；选段翻译/解释/提问；默认发送所选+相邻两段 ≤3000 字符；标注"AI 辅助内容"，可缓存复用并展示用量 |
| 10.2 可访问性 | 键盘可操作隐藏/恢复入口、焦点样式、深浅主题、字号缩放 |

## 打包与分发

用 electron-builder（配置见 `electron-builder.yml`）把 `out/` 产物封成可双击运行的 Windows 程序：

```bash
npm run dist:win   # 便携版 + 安装版，产物在 dist/
npm run icon       # 从 export/export/desktop 重新生成 build/ 下图标与托盘图
```

要点：

- 应用图标：`build/icon.ico`（多尺寸），electron-builder 内嵌进 exe 与安装界面；右下角托盘用 `resources/tray.png`。
- 数据落在 `%APPDATA%\privacy-reader`（`reader.db` 与 `settings.json`），便携版与安装版共用同一份数据；卸载不会删除这些数据。
- 应用是单实例（`requestSingleInstanceLock`）：若已有实例在跑，第二个会直接退出——这也是"双击没反应"的常见原因。
- 未做代码签名（无证书），首次运行会有 SmartScreen 提示；`CSC_IDENTITY_AUTO_DISCOVERY=false` 已让 CI 跳过签名。

## 用 GitHub Actions 自动打包与下载

仓库内置 `.github/workflows/build.yml`：

- 推送 `v*` 标签（`git tag v0.1.0 && git push origin v0.1.0`）→ 在 `windows-latest` 上 `npm ci` + `npm run dist:win` → 自动创建/更新 **GitHub Release** 并把两个 exe 作为下载资产上传。
- 普通 push / PR / 手动触发（Actions 页 "Run workflow"）→ 只构建并把产物挂在该次运行的 **Artifacts**（约 90 天过期，供自测）。

首次启用：仓库 Settings → Actions → General → Workflow permissions 选 "Read and write permissions"，让 Release 步骤有权限发布。

## 手机端

当前是 **Electron 桌面程序，不能直接跑在手机上**。上手机需另起一套：

- **Capacitor 包壳**：复用 `src/renderer` 的 React 界面，但数据层要重写（手机没有 Node / sql.js 的 `fs` 路径 / Windows DPAPI），换成 Capacitor Filesystem + WASM/原生 SQLite，加密改用 Keystore/Keychain。
- **React Native / Flutter 重写**：体验更好，但等于把阅读器、导入、隐私锁、AI 辅助各做一遍；`src/shared` 的数据模型可作跨端契约复用。
- "隐藏/中性界面/托盘/全局快捷键"这套桌面专属交互，在手机端要重新设计（如后台快照保护、生物识别解锁）。

建议先把 Windows 版用顺、稳定 `src/shared` 的数据契约与同步接口，再评估路线。

## 已知限制（验证版如实声明）

- 同步、网页 URL 导入、书源适配器：仅预留数据模型与接口，未接入服务端。
- 全局快捷键与任务切换预览保护需按系统逐项实测；`SetWindowDisplayAffinity` 屏幕捕获保护未启用（P1）。
- 中文全文检索为 LIKE 扫描，100MB 级库需换 FTS5 分词方案。
- 移动端与 macOS 不在本版范围。

## 项目结构

```
src/main/       Electron 主进程：db(sql.js) / importer(TXT+EPUB) / ai(OpenAI 兼容)
                / privacy(隐藏状态机+快捷键+托盘) / crypto(PIN+AES-GCM+DPAPI) / settings
src/preload/    contextBridge 白名单 API
src/renderer/   React：继续阅读 / 书库 / 导入 / 阅读器(目录·批注·AI面板) / 设置 / 隐私中性界面
src/shared/     IPC 与数据模型类型（未来移动端复用）
assets/         README 用的图标与截图
resources/      托盘图标（随包发布）
scripts/        图标生成、解析/持久化/导入冒烟测试等
```

测试素材在 `samples/`：公版全文《水浒传》（Project Gutenberg 版，71 回）、《西厢记》（古文岛版，五本二十五折）、古文 TXT、英语 TXT、最小 EPUB。

## 许可

UNLICENSED（暂未选择开源许可）。如需调整 LICENSE 请告知。
