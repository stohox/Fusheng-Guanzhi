# 「浮生观止」privacy-reader 代码审查与优化建议

- 审查日期：2026-10-15
- 审查范围：src/main 全部 7 模块、src/preload、src/renderer 全部视图与组件、electron-builder.yml、electron.vite.config.ts、.github/workflows/build.yml、.gitignore
- 基线：v0.1.1（bfe3abd），`npm run typecheck` 双 tsconfig 通过，工作区干净
- 结论：**工程基础面良好（contextIsolation、CSP、SQL 参数化、DPAPI、单实例锁均在位），但存在 1 个数据丢失级 bug、2 个数据可靠性/健壮性红线，以及一批随数据量增长会逐步显现的性能债。**

严重度图例：🔴 红线（尽快修） · 🟠 重要（条件触发/增长后必踩） · 🟡 建议修（小成本） · 🟢 良好实践（确认无需动）

---

## 一、问题总表

| # | 严重度 | 模块/位置 | 问题 | 影响 |
|---|---|---|---|---|
| 1 | 🔴 | db.ts `purgeDeleted()` | 回收站清理无 30 天过滤，`WHERE deleted_at IS NOT NULL` 全量清除 | **用户删书→重启→永久丢失**，与 UI 承诺"30 天后自动清除，可恢复"直接矛盾 |
| 2 | 🔴 | db.ts `persistNow()` | `writeFileSync` 非原子覆盖 reader.db | 写入中途崩溃/断电→库文件损坏→initDb 抛错→应用无法启动且数据全丢 |
| 3 | 🔴 | importer.ts `parseEpub()` | `MAX_EXPANDED_BYTES`(200MB) 定义未使用；`unzipSync` 无解压上限 | 恶意/损坏 EPUB（zip bomb）解压撑爆内存，OOM 崩溃 |
| 4 | 🟠 | package.json | Electron 33 已停止安全维护（EOL），vite 5 / electron-vite 2.3 偏旧 | Chromium 内核无安全补丁；本地应用攻击面小，属依赖债 |
| 5 | 🟠 | db.ts `persist()` | sql.js 整库 `export()` 写盘的写放大：每次写操作 400ms 防抖后全量序列化 | 库到几十 MB 后，5 秒一次进度保存造成主进程周期性卡顿 + SSD 写放大 |
| 6 | 🟠 | importer.ts `runParse()` | 同步 `readFileSync` + `unzipSync` + 正则解析 + 逐章 AES 加密全在主进程主线程 | 大文件导入时窗口/托盘/快捷键冻结数秒 |
| 7 | 🟠 | db.ts `initDb()` | 无 schema 版本管理（`PRAGMA user_version` 未用），表结构靠 `CREATE TABLE IF NOT EXISTS` | 下次改表结构时老用户库无法升级 |
| 8 | 🟠 | db.ts `books.purge()` | 8 条 DELETE 无事务包裹 | 中途失败留孤儿数据（对比 `chapters.insertAll()` 有事务） |
| 9 | 🟠 | crypto.ts `verifyPin()` | PIN 无失败计数/退避，4 位 PIN 仅 1 万组合 | 本地攻击者可暴力破解（scrypt 单次几十 ms，1 万次仅数分钟） |
| 10 | 🟠 | ImportView `PreviewForm` + importer.ts | 重复导入选"打开已有内容"分支不调 `cancelImport`，`parsedStore` 持有整个文件 Buffer（≤100MB）直到退出 | 内存泄漏；任务状态永远停在 await_preview |
| 11 | 🟡 | ReaderView `onScroll` | 每次滚动 `querySelectorAll('[data-pidx]')` 全量遍历 + 逐个 `getBoundingClientRect` | 大章节（数千段）滚动掉帧 |
| 12 | 🟡 | store.tsx | store 对象每次渲染重建且未 memo，单一 context | 任何 state 变化→全 app 重渲染；与 #11 在滚动链路上叠加 |
| 13 | 🟡 | LibraryView useEffect | 对每本书**串行** await `librariesOf` + `tagsOf` | N 本书 = 2N 次 IPC 往返 + N 次 setState 重渲染 |
| 14 | 🟡 | ReaderView `onMouseUp` | 跨段选择时 `para.indexOf(sel.toString())` 返回 -1 → 偏移记为 0 | 跨段划线/批注的锚点错误 |
| 15 | 🟡 | crypto.ts `getMasterKey()` | 降级路径问题：safeStorage 不可用时明文存 key；DPAPI 环境变化时解密失败的提示误导（报"PIN 曾被重置"） | 用户误判故障原因；静态加密在降级时形同虚设且无 UI 提示 |
| 16 | 🟡 | db.ts `search()` | LIKE 转义漏了反斜杠本身；`search_fts` 非 FTS 虚表，全表 LIKE 扫描 | 含 `\` 的搜索词结果不准；数据量大后搜索变慢 |
| 17 | 🟡 | App.tsx `GlobalSearch` | 新搜索词输入时旧结果未清空；结果列表用数组下标作 key | 显示过期结果的小 UX 问题 |
| 18 | 🟡 | build.yml | PR 也跑完整 `electron-builder` 打包 | 每个 PR 5–10 分钟；PR 只需 build+typecheck 冒烟 |
| 19 | 🟡 | 工程 | 无单元测试；无 ESLint 配置（代码里却有 eslint-disable 注释） | 解析器（parseTxt/parseEpub/decodeText）是纯函数，最值得测却零覆盖 |
| 20 | 🟡 | privacy.ts | 回收站清理只在启动时执行一次 | 长期挂机（从不重启）回收站永不清理（#1 修复时一并处理） |

---

## 二、红线问题详述

### #1 回收站"30 天清理"实为"启动即清空"（数据丢失 bug）

位置：`src/main/db.ts` L211-214

```ts
purgeDeleted(): void {
  const rows = all(`SELECT id FROM books WHERE deleted_at IS NOT NULL`, [], (r) => n(r.id))
  for (const id of rows) books.purge(id)
}
```

`WHERE deleted_at IS NOT NULL` 没有任何时间过滤。调用链：`index.ts` L456 `initDb().then(() => { ... books.purgeDeleted() ... })`——每次启动执行。也就是说：**用户刚把书移入回收站（哪怕 1 分钟前），重启应用后该书连同章节、批注、书签、进度被物理删除**。LibraryView 的确认弹窗写着"30 天后自动清除，可在回收站恢复"，行为与承诺完全相反。

修复（一行 WHERE + 参数）：

```ts
purgeDeleted(): void {
  const cutoff = Date.now() - 30 * 86400_000
  const rows = all(
    `SELECT id FROM books WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
    [cutoff],
    (r) => n(r.id)
  )
  for (const id of rows) books.purge(id)
}
```

同时建议把 30 天抽成常量并在设置页可见（或至少与 UI 文案同源），避免两处口径漂移。

### #2 persistNow 非原子整库覆盖写

位置：`src/main/db.ts` L100-108

```ts
const data = db.export()
fs.writeFileSync(dbPath(), Buffer.from(data))
```

sql.js 是"整文件进内存、整文件落盘"的模型，`writeFileSync` 直接截断覆盖目标文件。若在写入过程中发生崩溃/断电/强杀（任务管理器），reader.db 变成半截文件；下次启动 `new SQL.Database(existing)` 解析失败抛错，`initDb().then(...)` 链上无 catch → **应用白屏起不来，且原数据已被覆盖无法找回**。

修复（临时文件 + 原子 rename + 保留一份 .bak）：

```ts
export function persistNow(): void {
  if (!db) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const data = Buffer.from(db.export())
  const p = dbPath()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, data)                       // 先写临时文件
  try { fs.copyFileSync(p, p + '.bak') } catch { /* 首次运行无库 */ }
  fs.renameSync(tmp, p)                             // 原子替换（Windows 走 MoveFileEx）
}
```

并在 `initDb()` 加损坏恢复路径：主库 `new SQL.Database()` 抛错时，尝试读 `reader.db.bak`；再失败才新建空库（并提示用户）。当前 initDb 对损坏文件没有任何兜底。

### #3 EPUB 解压无上限（zip bomb）

位置：`src/main/importer.ts` L128 `unzipSync(new Uint8Array(buf))`；L318-320

```ts
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 200 * 1024 * 1024  // ← 定义了，从未使用
export const MAX_CHAPTERS = 5000
```

`MAX_FILE_BYTES` 只限制**压缩后**文件 ≤100MB，但 `unzipSync` 会把 EPUB 内**全部**条目（含内嵌图片）一次性解压到内存，无任何条目/总量限制。一个精心构造（或 merely 损坏膨胀）的 EPUB 可在 100MB 压缩体积下展开出数 GB，直接 OOM。`MAX_EXPANDED_BYTES` 显然本意就是防这个，只是没接线。

修复方向（两选一）：

- ★ 简单：解压后立刻累计 `Object.values(files)` 各条目 `length`，超限 throw（内存峰值仍会被短暂顶高，但进程不会死）；
- 更稳：改用 fflate 的流式/逐条目解压（`unzip` 异步回调版），在累计超过 200MB 时中断并抛"EPUB 解压后超过 200MB 限制"。

对本地单用户应用这是低概率场景，但常量已定义未接线属于"意图明确、实现漏掉"，成本极低。

---

## 三、重要问题（🟠）要点

- **#5 sql.js 写放大**：每条 `run()` 都触发 `persist()`（400ms 防抖全量 export）。阅读器每 5 秒存一次进度 → 库体积增长后每 5 秒一次"全库序列化 + 全量写盘"。这是架构性选择（换 zero-native 依赖）的代价，MVP 期完全可用；**书库累计到 50MB+ 时应重新评估**。
  - ★ 推荐路径：升级 Electron 到 Node ≥22.5 内核的版本后，改用 Node **内置 `node:sqlite`**（DatabaseSync），零原生编译、零 npmRebuild 冲突（当前 `npmRebuild: false` 可保留），写盘回归 SQLite 原生增量页级写入。需验证所选 Electron 版本对应 Node 的 `node:sqlite` 是否已脱离实验 flag。
  - 备选：`better-sqlite3`（成熟但原生模块，需 electron-rebuild + asarUnpack `.node`，与现有 `npmRebuild: false` 冲突，迁移成本更高）。
- **#6 导入解析阻塞主进程**：`setTimeout(..., 30)` 只是延迟不解决阻塞。中期把解析挪 `utilityProcess`/`worker_threads`；短期可在解析前 `setState` 后用 `setImmediate` 让 UI 先画出"解析中"。
- **#7 schema 版本**：加 `PRAGMA user_version` + 顺序迁移数组，v0.2 起任何表结构变更都走迁移。现在补是十分钟的事，等有存量用户再补就要写数据抢救逻辑。
- **#9 PIN 防爆破**：内存计数 + 指数退避（5 次失败 → 30s 冷却，逐次翻倍，重启清零或持久化均可，产品定位是"提高门槛"）。
- **#10 "打开已有"分支泄漏**：ImportView `confirm()` 的 `dupAction === 'open'` 分支补 `await window.reader.cancelImport(task.id, false)` 即可（后端 `cancelTask` 已正确清理 parsedStore）。

## 四、建议修问题（🟡）要点

- **#11/#12 滚动渲染链**：`onScroll` 改 IntersectionObserver 记录当前段落；`ReaderView` 段落列表抽成 memo 组件；store 用 `useMemo`。三者独立可分步做。
- **#13 书库页批量接口**：主进程加 `books:relations`（单次 JOIN 返回全量映射），消灭 2N 次串行 IPC。
- **#14 跨段划线偏移**：`startOffset` 计算前先判断 selection 是否单段（`sel.toString()` 不含 `\n`），跨段时按段首段计算或提示。
- **#15 密钥降级可见性**：设置页显示"本机加密保护：DPAPI ✓ / 文件降级 ⚠"；解密失败错误信息区分"DPAPI 环境变化"与"PIN 重置"两种文案。
- **#16 搜索**：LIKE 转义补 `\\`；数据量增长后 `search_fts` 可换 FTS5 + trigram tokenizer（sql.js 内置 SQLite 3.45 支持，需验证 wasm 编译包含 FTS5）。
- **#18 CI 分流**：`pull_request` 与 `push: main` 只跑 `npm run build` + typecheck；仅 `tags: v*` 跑 `dist:win`。
- **#19 测试**：优先给 `parseTxt`（章节正则）、`parseEpub`（OPF/spine/ncx）、`decodeText`（编码回退）上 vitest 快照测试，samples/ 目录现成的测试语料。

## 五、良好实践确认（不动）

| 项 | 状态 |
|---|---|
| contextIsolation: true + nodeIntegration: false，preload 白名单事件通道 | 🟢 |
| CSP `default-src 'self'`，无 dangerouslySetInnerHTML，React 默认转义 | 🟢 |
| SQL 全参数化绑定，LIKE `%_` 转义 | 🟢 |
| 密钥链路：scrypt PIN / AES-256-GCM 正文 / DPAPI 包裹 master key 与 API key | 🟢 |
| 单实例锁（配合整库覆盖写的并发保护，注释说明清楚） | 🟢 |
| AI 结果在隐藏态丢弃、锁定态拒发（状态机门禁） | 🟢 |
| asarUnpack wasm、CI 产物/发布分离、--publish never 修复链 | 🟢 |
| .gitignore 覆盖完整（运行时数据、export、构建产物均不入库），工作区干净 | 🟢 |
| typecheck（node + web 双 tsconfig）零错误 | 🟢 |

---

## 六、分批修复路线（★ 推荐默认）

| 批次 | 内容 | 规模 | 说明 |
|---|---|---|---|
| **A：数据安全加固 ★** | #1 30 天过滤、#2 原子写+损坏恢复、#3 解压上限、#8 purge 事务、#10 open 分支泄漏、#14 跨段偏移 | ~1 小时 | 全部小 diff、零架构改动；#1/#2 是真实数据丢失风险，建议随 v0.1.2 发出 |
| **B：体验与卫生** | #20 清理改启动+定时、#9 PIN 退避、#15 保护级别显示、#13 批量接口、#17、#18 CI 分流 | ~半天 | 互相独立，可拆 PR |
| **C：结构升级（先评估再动）** | #5 node:sqlite/better-sqlite3 迁移评估、#6 utilityProcess、#7 user_version、#4 Electron 升级 | 1–2 天 | #4 与 #5 联动（升级 Electron 才有 node:sqlite），建议合并为一次专项 |
| **D：按需** | #11/#12 渲染性能、#16 FTS5、#19/#20 测试与 lint | 按需 | 等真实卡顿/数据量信号再做 |

> 批次 A 均为只读审查后可直接落地的修复；按惯例，源码改动先行，打包/发布由你显式触发。
