import { useEffect, useRef, useState } from 'preact/hooks';
import { clearAll, countTrackPoints } from '../db/db';
import { exportToFile, importFromFile } from '../backup/localFile';
import { BackupFormatError } from '../domain/merge';
import { Dialog } from './Dialog';
import { loadAll, useAppState } from './store';

const PERSIST_TEXT = {
  granted: '已開啟：瀏覽器不會自動清除資料',
  denied: '未開啟：瀏覽器空間不足時可能清除資料，請記得定期匯出備份',
  unsupported: '這個瀏覽器不支援持久儲存，請記得定期匯出備份',
};

export function SettingsPage() {
  const app = useAppState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tracks, setTracks] = useState<number | null>(null);
  const [clearStep, setClearStep] = useState(0);

  useEffect(() => {
    void countTrackPoints().then(setTracks);
  }, [app.events]);

  const liveCount = app.events.filter((e) => !e.deleted).length;

  const doExport = async () => {
    setBusy(true);
    try {
      const r = await exportToFile();
      if (r.outcome !== 'cancelled') {
        setMsg({
          title: '匯出完成',
          body: `${r.name}\n共 ${r.count} 筆事件。${r.outcome === 'downloaded' ? '檔案已下載。' : ''}`,
        });
      }
    } catch (e) {
      setMsg({ title: '匯出失敗', body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    try {
      const r = await importFromFile(file);
      await loadAll();
      setMsg({
        title: '匯入完成',
        body:
          r.added + r.updated === 0
            ? '檔案裡的資料本機都已經有了，沒有任何變動。'
            : `新增 ${r.added} 筆、更新 ${r.updated} 筆（含事件、車資、軌跡）。`,
      });
    } catch (e) {
      setMsg({ title: '無法匯入', body: e instanceof BackupFormatError ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div class="settings">
      <section class="card">
        <h2>資料</h2>
        <p>
          事件 {liveCount} 筆・軌跡點 {tracks ?? '…'} 筆
        </p>
        <p class={app.persist === 'granted' ? 'ok' : 'warn'}>
          持久儲存：{app.persist ? PERSIST_TEXT[app.persist] : '檢查中…'}
        </p>
      </section>

      <section class="card">
        <h2>本機匯出／匯入</h2>
        <p class="muted">匯出成 .json.gz 檔，可以存到雲端硬碟或傳給自己。匯入時會合併，不會覆蓋較新的資料。</p>
        <div class="btn-col">
          <button type="button" class="btn primary" disabled={busy} onClick={() => void doExport()}>
            匯出備份檔
          </button>
          <button type="button" class="btn secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            匯入備份檔
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.gz,application/json,application/gzip"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void doImport(f);
          }}
        />
      </section>

      <section class="card">
        <h2>開發模式</h2>
        <p class="muted">清空手機上的所有 DB-radar 資料。請先匯出備份，清空後無法復原。</p>
        <button type="button" class="btn danger" onClick={() => setClearStep(1)}>
          清空資料庫
        </button>
      </section>

      {clearStep > 0 && (
        <Dialog title="清空資料庫" onClose={() => setClearStep(0)}>
          <p>
            {clearStep === 1
              ? `會刪除 ${liveCount} 筆事件、所有車資與軌跡，而且無法復原。確定要繼續嗎？`
              : '最後確認：真的要清空嗎？'}
          </p>
          <div class="btn-row">
            <button type="button" class="btn secondary" onClick={() => setClearStep(0)}>
              取消
            </button>
            <button
              type="button"
              class="btn danger"
              onClick={() => {
                if (clearStep === 1) return setClearStep(2);
                void clearAll()
                  .then(loadAll)
                  .then(() => {
                    setClearStep(0);
                    setMsg({ title: '已清空', body: '所有資料已刪除。' });
                  });
              }}
            >
              {clearStep === 1 ? '繼續' : '確定清空'}
            </button>
          </div>
        </Dialog>
      )}

      {msg && (
        <Dialog title={msg.title} onClose={() => setMsg(null)}>
          <p class="pre">{msg.body}</p>
          <button type="button" class="btn primary" onClick={() => setMsg(null)}>
            好
          </button>
        </Dialog>
      )}
    </div>
  );
}
