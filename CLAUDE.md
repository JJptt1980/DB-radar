# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案是什麼

DB-radar：給 Uber 司機自己用的熱點雷達 PWA（對外名稱「熱點雷達」）。司機用大按鈕記錄上線／接單／上客／下客／下線，App 只用**自己的**資料算出「這個時段、附近哪裡最容易接到好單」，用圓形雷達畫面指方向。沒有後端：資料存在手機的 IndexedDB，備份到使用者自己的 Google Drive（`drive.file` 權限）。

- 規格：`SPEC.md`（功能與演算法都以它為準，改行為時要一起更新）。進度：`docs/STATUS.md`（開工前先讀，做完一件事要更新）。
- 網頁版 2026-11-20 已發 v1.0.0 並凍結，只修 bug、調參數。可上架的 App 是另一個專案 `~/Projects/hotspot-radar`，不要在這個 repo 裡做。
- 部署：push 到 `main` 後 GitHub Actions 會跑測試、建置，並部署到 https://jjptt1980.github.io/DB-radar/ （`vite.config.ts` 的 `base` 是 `/DB-radar/`）。

## 指令

```bash
npm install
npm run dev                          # 開發伺服器
npm test                             # vitest，全部測試（tests/**/*.test.ts）
npx vitest run tests/home.test.ts    # 只跑一個檔
npx vitest run -t '順路回家'          # 只跑名稱符合的測試
npm run build                        # tsc --noEmit 型別檢查 + vite build（沒有另外的 lint）
python3 -m unittest discover -s tests -p '*_test.py'   # 影片匯入器的 Python 測試（CI 也會跑）
```

`.claude/launch.json` 有 `preview` 設定（vite preview，port 4173），網址要開 `http://localhost:4173/DB-radar/`。預覽瀏覽器沒有 GPS，雷達會用 `Settings.homeCenter`（台北車站）當目前位置；設定頁的「開發模式」可以產生和清除假資料。

## 架構

技術：Preact + TypeScript + Vite + vite-plugin-pwa，IndexedDB 用 `idb`，空間格子用 H3（`h3-js`，預設 res 8），地圖用 Leaflet。

資料流（由下往上）：

1. **`src/db/`**：IndexedDB schema 與型別。`types.ts` 的 `SCHEMA_VERSION`、`Settings`、`DEFAULT_SETTINGS`、`BackupFile`。讀設定時是 `{ ...DEFAULT_SETTINGS, ...存的值 }`，所以新加的設定欄位要給預設值。
2. **`src/domain/`**：純函式。`state.ts` 是事件狀態機（offline → idle → enroute → ontrip），`geo.ts` 算距離和方位，`migrate.ts` 處理舊資料升級，`merge.ts` 合併資料。
3. **`src/analytics/`**：純函式，是核心演算法（SPEC 第 4 章）：
   - `slots.ts`：時段 = 日型（平日／週五／週六／週日／國定假日）× 小時，一律用**台北時間**。
   - `stats.ts` 的 `buildStats` 把事件、軌跡、匯入的官方資料整理成 `StatsIndex`（每個槽位 × H3 格子的空車時數、單數、實收、耗時）。
   - `model.ts`：`viewAt` 混合相鄰時段，`estimate` 逐層收縮（全城 → 同時段 → 鄰居 → 本格），`recommend` 算預期時薪 `(V − cost) / (T + W + D) × 60` 並排序。
   - 建在這之上的功能：`quit.ts` 收工建議、`home.ts` 順路回家、`summary.ts` 統計頁、`heat.ts` 熱力圖、`officialFares.ts` 用 Uber 官方資料補車資。
4. **`src/ui/`**：`store.ts` 是全域 App 狀態（載入資料、按按鈕、GPS 補位置、自動備份）；`useAnalytics.ts` 依「資料版本 key」快取 `buildStats` 的結果，雷達頁和統計頁共用。改了會影響統計的設定欄位，要記得加進這個 key。`RadarPage.tsx` 用 Canvas 自己畫雷達。
5. **`src/sensors/`**（GPS、方向、Wake Lock、持久儲存）、**`src/backup/`**（Google Drive 備份與還原、保留策略）、**`src/import/`**（解析 Uber 官方資料 zip）。

其他：
- `public/about/index.html` 是獨立的靜態宣傳頁，service worker 刻意不攔截它。
- `tools/video-import/` 是 Mac 端的行程影片 OCR 工具（Python + Swift），不打包進網頁版；網頁版已經拿掉影片匯入的入口。

## 慣例（SPEC 第 12 章與已定案的決定）

- `src/analytics/` 和 `src/domain/` 必須是純函式，而且要有單元測試；UI 不寫自動化測試，改在瀏覽器預覽裡實際操作驗證。
- 會改變資料格式的修改：遞增 `SCHEMA_VERSION` 並寫 migration，不能讓使用者已累積的資料遺失。
- 不用 `alert`／`confirm`／`prompt`，一律用 `src/ui/Dialog.tsx`。
- 介面文字、程式註解都用繁體中文（台灣用語）。
- `tests/fixtures/*.json` 是真實行程資料，已列入 gitignore，絕不能推上 repo（repo 是公開的）。
- 只用使用者自己的資料，絕不收集別人的資料。雷達外觀只用方格底、黃點、紅色三角形，不仿製原作道具的外殼、名稱和音效。
- 版面要簡潔、雷達盡量放大；新增的資訊用一行小字呈現。
