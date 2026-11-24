# DB-radar

[![Ko-fi](https://img.shields.io/badge/Ko--fi-%E8%AB%8B%E6%88%91%E5%96%9D%E6%9D%AF%E5%92%96%E5%95%A1-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/jjptt1980)

司機用的個人熱點雷達 PWA。規格見 [SPEC.md](SPEC.md)。

網址：https://jjptt1980.github.io/DB-radar/

## 問題回報

使用上有任何問題或建議，歡迎到 JJptt Facebook 粉專留言或私訊反應：https://www.facebook.com/1466948699840024

## 開發

```bash
npm install && npm run dev
```

測試與建置：`npm test`、`npm run build`。推送到 `main` 後，GitHub Actions 會自動部署到 GitHub Pages。

## Google Drive 備份設定

App 用 Google Identity Services 的 token client 直接在瀏覽器取得權杖，沒有後端。權限只有 `drive.file`：App 只看得到它自己建立的檔案，備份放在 Drive 的「DB-radar 備份」資料夾，只保留最新 30 份。

要自己建一組 OAuth 用戶端時：

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案（免費）。
2. 「API 和服務」→「程式庫」→ 啟用 **Google Drive API**。
3. 「OAuth 同意畫面」：類型選「外部」，狀態保持「測試中」，把自己的 Gmail 加入測試使用者。
4. 「憑證」→ 建立 **OAuth 用戶端 ID**，類型「網頁應用程式」。已授權的 JavaScript 來源填 `https://<帳號>.github.io`，本機開發再加 `http://localhost:5173`。
5. 把用戶端 ID 填進 App 的 設定 → Google Drive 備份 → 進階。用戶端 ID 不寫在程式碼裡；部署時也可以設成 GitHub repo 變數 `GOOGLE_CLIENT_ID`，建置時會帶入當作預設值：

```bash
gh variable set GOOGLE_CLIENT_ID --body "<用戶端 ID>"
```

## 已知限制

- App 在背景時無法記錄位置（PWA 的限制）。
- 瀏覽器可能清除網站資料，所以備份很重要。
