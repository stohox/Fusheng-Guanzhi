<div align="center">

<img src="assets/icon.png" width="128" height="128" alt="Fusheng Guanzhi icon" />

# 浮生观止 · Fusheng Guanzhi

**A local-first, one-key-hidable private reader for classic Chinese & English texts (Windows)**

[中文说明](README.md) · [Downloads (Releases)](https://github.com/stohox/privacy-reader/releases)

</div>

---

Fusheng Guanzhi is a reader whose **data never leaves your machine**. Import TXT / EPUB / Markdown and read offline,
with library & tag management, table-of-contents navigation, bookmarks and highlights, auto-saved reading progress, and
an AI panel that translates / explains the passage you select. It ships two privacy interactions for the "someone glancing
over your shoulder" case: **one-key hide** and a **focus overlay**.

This is the Windows verification build of the "Multi-device Private Reading App PRD v1.0", covering the full loop:
import → classify → read → hide & reveal → persist annotations/progress → AI-assisted passage help.

Stack: **React 18 + TypeScript + Electron** (no Rust on this machine, so Tauri was not chosen; the desktop hide
requirements are met with Electron windows / shortcuts / tray). The data layer is **SQLite (sql.js / WASM)**; text is stored
in a unified "chapter → paragraph → text" model, reserving the same core for future mobile and sync.

## Screenshots

> Drop images into `assets/screenshots/` and they appear here automatically (filenames below).

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/library.png" width="360" alt="Library"/><br/>Library & tags</td>
    <td align="center"><img src="assets/screenshots/reader.png" width="360" alt="Reader"/><br/>Reader (TOC / notes / AI panel)</td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/import.png" width="360" alt="Import"/><br/>Import & classification review</td>
    <td align="center"><img src="assets/screenshots/focus.png" width="360" alt="Focus overlay"/><br/>Focus overlay (on top of the desktop)</td>
  </tr>
</table>

## Quick start

**Users — just download:**

Grab a build from the [Releases page](https://github.com/stohox/privacy-reader/releases):

- `浮生观止-便携版-x.y.z.exe` — portable single file, double-click to run.
- `浮生观止-安装版-x.y.z.exe` — installer with desktop / start-menu shortcuts.

> Unsigned: on first launch Windows SmartScreen shows "unknown publisher" — choose "More info → Run anyway".

**Developers — run from source:**

```bash
npm install        # npmmirror registry is preconfigured
npm run dev        # development (hot reload)
npm run build      # production build into out/
npm run dist:win   # package a double-clickable Windows app (output in dist/)
```

## How to use

**Import.** Go to *Import* and pick a local TXT / EPUB / Markdown file. After parsing you get a preview: edit title,
author, language, libraries and tags, review the chapter list and completeness. Dedup uses "filename + size + first-block
hash"; on a hit you can "open existing" or "keep as new version". Confirm to store it. Classification follows
"manual lock → user rules → keyword suggestion"; suggestions only show a reason and confidence and require your confirmation —
nothing is moved automatically.

**Library & reading.** *Library* browses everything by library/tag, with bulk move and delete (30-day trash).
Open a book to enter the reader: a left TOC jumps between chapters; the body supports in-book search, font size / line height /
typeface / three themes, bookmarks, and highlights (bound to chapter + paragraph + offset). A toolbar "Original / Simplified / Traditional"
button toggles the display script — a **render-time** conversion only, so stored text, bookmarks, notes, search and progress are all unaffected
(classical Traditional texts can be read instantly in Simplified, and vice versa). Reading progress is saved locally every 5 seconds; reopening
a book — from "Continue reading" or the "Library" — returns precisely to the last chapter *and* paragraph, re-anchored by a context snippet so it
stays accurate across font/line-size changes and text updates.

**AI passage help.** Select a passage in the reader and the right AI panel translates / explains / answers questions.
By default it sends the selection plus the two adjacent paragraphs (≤ 3000 chars) to the model; results are labeled "AI-assisted content"
and can be copied, saved as a note, regenerated, or cancelled. Configure any OpenAI-compatible endpoint in *Settings* (Base URL / Key / model);
the key is stored encrypted via the OS keystore.

**Privacy hide.** Press the hide shortcut at any time (default `Alt+Shift+H`): it first covers the text/title/notes/translation/AI panel,
then switches to a neutral "notes" screen. You can enable hide-on-blur, hide-on-idle, and lock-on-hide (PIN is a scrypt hash).
Forgetting the PIN only resets the local lock and clears protected text; other data is untouched. The tray menu (bottom-right) offers "Show / Quit".

**Focus overlay.** Press `Alt+Shift+Z` for focus view: the reading UI is de-book-ified (title, chapter header and progress hidden),
the window title becomes a neutral name, and the text floats softly over your desktop. In this state the window is
**click-through** to the desktop (everything except the text column and the control bar passes clicks to what's behind),
with a bottom control bar; `Ctrl+,` opens a quick panel for font size / column width / height / opacity / brightness / palette / always-on-top.
Press `Esc` twice to hide to the tray.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt + Shift + H` | One-key hide / reveal (global shortcut, default; changeable in Settings; falls back to in-app shortcut & the "Hide" button on conflict) |
| `Alt + Shift + Z` | Toggle focus view (stealth overlay) |
| `Ctrl + ,` | Open / close the quick panel (font size, column width/height, opacity, brightness, palette, always-on-top) |
| `Esc` | Close the panel; in focus view, press **twice** to hide to the tray |
| `Space` / `→` / `↓` / `PgDn` | Reader: next page (auto-advances to next chapter at the end) |
| `←` / `↑` / `PgUp` | Reader: previous page (auto-goes to previous chapter at the top) |
| `Home` / `End` | Reader: jump to start / end of the chapter |
| Mouse wheel | Reader: page by screen |
| `Ctrl` + wheel | Reader: zoom font size (12–32) |

## PRD coverage (P0 · verification scope)

| Requirement | Implementation |
|---|---|
| IN01/02 Import & task states | Local TXT/EPUB/MD import; states queued→parsing→await preview→done/partial/failed/cancelled; 100MB / 5000-chapter caps |
| 4.3 Preview & dedup | Edit title/author/language/library/tags before storing; show chapters & completeness; fingerprint dedup |
| LB01/02 Library & tags | Multi-library multi-tag (single body), all/uncategorized views, bulk move/delete, 30-day trash |
| LB03/04 Classification | Priority manual→rules→keyword suggestion; reason & confidence, human-confirmed; re-analyzable |
| RD01/02 Reader | TOC, chapter switching, in-book search, font/line/type/three themes, Simplified/Traditional display toggle, bookmarks, highlights; progress saved every 5s, precise resume to chapter+paragraph |
| 6.1 Position anchors | chapter + paragraph + char offset + context snippet, works across font sizes; re-matched on text updates |
| PR01-03 Privacy | Global hide shortcut; cover-then-neutral; hide-on-blur/idle; lock-on-hide (scrypt PIN); persists covered across restart; neutral tray text |
| DP01 Encryption | Private-library text AES-256-GCM at rest, master key protected by Windows DPAPI (safeStorage); API key encrypted too |
| AI01-04 Language help | OpenAI-compatible config; translate/explain/ask on selection; sends selection + 2 adjacent paragraphs ≤3000 chars; labeled "AI-assisted", cacheable with usage shown |
| 10.2 Accessibility | Keyboard-operable hide/reveal, focus styles, light/dark themes, font scaling |

## Packaging & distribution

electron-builder (see `electron-builder.yml`) wraps `out/` into a double-clickable Windows app:

```bash
npm run dist:win   # portable + installer, output in dist/
npm run icon       # regenerate build/ icons and the tray icon from export/export/desktop
```

Notes:

- App icon: `build/icon.ico` (multi-size), embedded into the exe and installer; the bottom-right tray uses `resources/tray.png`.
- Data lives in `%APPDATA%\privacy-reader` (`reader.db` and `settings.json`), shared by the portable and installed builds; uninstalling does not delete it.
- Single instance (`requestSingleInstanceLock`): a second launch exits immediately — a common cause of "double-click does nothing".
- Unsigned (no certificate): SmartScreen warns on first run; `CSC_IDENTITY_AUTO_DISCOVERY=false` makes CI skip signing.

## Automated builds & downloads via GitHub Actions

The repo ships `.github/workflows/build.yml`:

- Push a `v*` tag (`git tag v0.1.0 && git push origin v0.1.0`) → on `windows-latest` it runs `npm ci` + `npm run dist:win` → creates/updates a **GitHub Release** and uploads both exes as downloadable assets.
- Regular push / PR / manual trigger (Actions → "Run workflow") → builds only and attaches the binaries to that run's **Artifacts** (expire in ~90 days, for self-testing).

First time: repo Settings → Actions → General → Workflow permissions → "Read and write permissions" so the Release step can publish.

## Mobile

This is an **Electron desktop app and cannot run on phones directly.** Going mobile needs a separate effort:

- **Capacitor shell**: reuse the React UI in `src/renderer`, but rewrite the data layer (no Node / no sql.js `fs` path / no Windows DPAPI on mobile) with Capacitor Filesystem + a WASM/native SQLite, and Keystore/Keychain for encryption.
- **React Native / Flutter rewrite**: better UX, but you rebuild the reader, import, privacy lock and AI help; the `src/shared` models serve as a cross-platform contract.
- The "hide / neutral screen / tray / global shortcut" desktop-only interactions must be redesigned for mobile (background snapshot protection, biometric unlock).

Recommendation: stabilize the Windows app and the `src/shared` data contract / sync interface first, then pick a route.

## Known limitations (honest for a verification build)

- Sync, web-URL import, and source adapters: data model and interfaces reserved only, no server wired up.
- Global shortcuts and task-switch preview protection need per-system testing; `SetWindowDisplayAffinity` capture protection is not enabled (P1).
- Chinese full-text search is a LIKE scan; a 100MB-scale library needs an FTS5 tokenizer approach.
- Mobile and macOS are out of scope for this version.

## Project layout

```
src/main/       Electron main: db(sql.js) / importer(TXT+EPUB) / ai(OpenAI-compatible)
                / privacy(hide state machine + shortcuts + tray) / crypto(PIN+AES-GCM+DPAPI) / settings
src/preload/    contextBridge whitelist API
src/renderer/   React: Continue / Library / Import / Reader(TOC·notes·AI) / Settings / privacy neutral screen
src/shared/     IPC & data-model types (reused by future mobile)
assets/         icon and screenshots used by the README
resources/      tray icon (shipped with the package)
scripts/        icon generation, parse/persist/import smoke tests
```

Test material is in `samples/`: full public-domain 《Water Margin》 (Project Gutenberg, 71 chapters), 《Romance of the Western Chamber》
(guwen.dao, five books / twenty-five acts), a classical Chinese TXT, an English TXT, and a minimal EPUB.

## License

UNLICENSED (no open-source license chosen yet). Let me know if you'd like to add one.
