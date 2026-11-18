# DB-radar

司機用的個人熱點雷達 PWA。規格見 [SPEC.md](SPEC.md)。

網址：https://jjptt1980.github.io/DB-radar/

## 開發

```bash
npm install && npm run dev
```

測試與建置：`npm test`、`npm run build`。推送到 `main` 後，GitHub Actions 會自動部署到 GitHub Pages。

## 已知限制

- App 在背景時無法記錄位置（PWA 的限制）。
- 瀏覽器可能清除網站資料，所以備份很重要。
