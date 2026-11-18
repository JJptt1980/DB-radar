# 行程影片匯入器

把 Uber Driver「行程費用紀錄」頁的螢幕錄影轉成 DB-radar 可以匯入的 JSON（規格見 SPEC 第 8 章）。只在 Mac 上執行，不打包進 PWA，也不使用雲端 OCR。

需要：ffmpeg、Xcode Command Line Tools（Swift）、Python 3。

```bash
python3 tools/video-import/run.py ~/Downloads/Screenrecording_YYYYMMDD_HHMMSS.mp4
```

輸出 `~/DB-radar-import/radar-video-YYYYMMDD.json`，傳到手機後在 DB-radar 設定頁 →「行程影片匯入」選它。

選項：

- `--out 檔名`：指定輸出位置
- `--no-geocode`：不查經緯度
- `--check 樣本.json`：和驗收樣本比對（經緯度與時間戳記不比）
- `--keep-frames`：保留抽出的畫面，方便除錯

地理編碼先用 Apple（免費）。查不到時，如果鑰匙圈裡有 Google Geocoding API 金鑰就改用 Google；金鑰不寫進程式碼：

```bash
security add-generic-password -s db-radar-google-geocoding -a "$USER" -w
```

畫面、OCR 結果與地理編碼快取都在 `~/DB-radar-import`。真實行程資料（包含 `tests/fixtures/*.json`）不要 commit。
