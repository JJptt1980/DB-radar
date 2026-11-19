import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '../db/types';
import { addFakeData, clearAll, clearFakeData, countTrackPoints, saveSettings, FAKE_PREFIX } from '../db/db';
import { startOfTaipeiDay } from '../domain/time';
import { lastFix } from '../sensors/gps';
import { exportToFile, importFromFile } from '../backup/localFile';
import { BackupFormatError } from '../domain/merge';
import { Dialog } from './Dialog';
import { VideoImportCard } from './VideoImport';
import { UberImportCard } from './UberImport';
import { DriveCard } from './DriveCard';
import { isStandalone, notificationPermission } from '../sensors/storage';
import { getState, loadAll, retryPersist, useAppState } from './store';

const getPersist = () => getState().persist;

const PERSIST_TEXT = {
  granted: '已開啟：瀏覽器不會自動清除資料',
  denied: '未開啟：瀏覽器空間不足時可能清除資料，請開啟 Google Drive 備份',
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
  const fakeCount = app.events.filter((e) => e.id.startsWith(FAKE_PREFIX)).length;

  const toggleSweep = async (on: boolean) => {
    await saveSettings({ ...getState().settings, radarSweep: on });
    await loadAll();
  };
  const setRadar = async (patch: Partial<Settings>) => {
    await saveSettings({ ...getState().settings, ...patch });
    await loadAll();
  };
  const toggleAskFare = async (on: boolean) => {
    await saveSettings({ ...getState().settings, askFare: on });
    await loadAll();
  };

  const doFake = async () => {
    setBusy(true);
    try {
      if (fakeCount > 0) await clearFakeData();
      const { generateFake } = await import('../dev/fake');
      const f = lastFix();
      const center = f ? { lat: f.lat, lon: f.lon } : getState().settings.homeCenter;
      const data = generateFake({
        center,
        endDay: startOfTaipeiDay(Date.now()),
        holidays: new Set(getState().settings.holidays),
        seed: Date.now() % 100000,
      });
      await addFakeData(data);
      await loadAll();
      setMsg({
        title: '已產生假資料',
        body: `${data.events.filter((e) => e.type === 'dropoff').length} 趟、${data.tracks.length} 個軌跡點，中心在${f ? '目前位置' : '預設中心（台北車站）'}。`,
      });
    } finally {
      setBusy(false);
    }
  };

  const doClearFake = async () => {
    setBusy(true);
    try {
      const n = await clearFakeData();
      await loadAll();
      setMsg({ title: '已清除假資料', body: `刪除 ${n} 筆假事件，真實記錄沒有動。` });
    } finally {
      setBusy(false);
    }
  };

  const doRetryPersist = async () => {
    setBusy(true);
    try {
      const notify = await retryPersist();
      const ok = getPersist() === 'granted';
      setMsg({
        title: ok ? '已開啟持久儲存' : '還是沒有開啟',
        body: ok
          ? '瀏覽器不會再自動清除 DB-radar 的資料。'
          : notify !== 'granted' && notificationPermission() !== 'granted'
            ? 'Chrome 把通知擋下來了（上方會出現「通知已封鎖」）。點那一列的齒輪，或到 Chrome 選單 → 設定 → 網站設定 → 通知，把 jjptt1980.github.io 改成允許，回來再按一次。'
            : 'Chrome 這次沒有同意。多用幾天後可能會自動開啟；在那之前請記得定期匯出備份。',
      });
    } finally {
      setBusy(false);
    }
  };

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
        {app.persist !== 'granted' && app.backup?.linked ? (
          <p class="muted">持久儲存：不需要。資料已同步到 Google Drive，就算瀏覽器清掉也能從 Drive 還原。</p>
        ) : (
          <p class={app.persist === 'granted' ? 'ok' : 'warn'}>
            持久儲存：{app.persist ? PERSIST_TEXT[app.persist] : '檢查中…'}
          </p>
        )}
        <p class="muted">開啟方式：{isStandalone() ? '主畫面圖示' : '瀏覽器分頁（建議改從主畫面圖示開啟）'}</p>
        {app.persist === 'denied' && !app.backup?.linked && (
          <>
            <p class="muted">
              Chrome 不會詢問，而是自己判斷要不要開啟。網站有通知權限時通常就會開啟。DB-radar
              不會發送任何通知，只是借用這個條件。
            </p>
            <button type="button" class="btn secondary" disabled={busy} onClick={() => void doRetryPersist()}>
              再申請一次持久儲存
            </button>
          </>
        )}
      </section>

      <DriveCard />

      <section class="card">
        <h2>外觀</h2>
        <p class="muted small">介面顏色（雷達螢幕和地圖維持深色）</p>
        <div class="chips">
          {(
            [
              ['dark', '深色'],
              ['light', '淺色'],
              ['system', '跟隨系統'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" class={app.settings.theme === k ? 'chip active' : 'chip'} onClick={() => void setRadar({ theme: k })}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section class="card">
        <h2>記錄</h2>
        <label class="toggle">
          <input
            type="checkbox"
            checked={app.settings.askFare}
            onChange={(e) => void toggleAskFare(e.currentTarget.checked)}
          />
          <span>下客後填車資（關掉時，車資等匯入 Uber 官方資料自動補上）</span>
        </label>
      </section>

      <section class="card">
        <h2>雷達</h2>
        <label class="toggle">
          <input
            type="checkbox"
            checked={app.settings.radarSweep}
            onChange={(e) => void toggleSweep(e.currentTarget.checked)}
          />
          <span>掃描線動畫（純裝飾，關掉比較省電）</span>
        </label>
        <label class="toggle">
          <input type="checkbox" checked={app.settings.radarSound} onChange={(e) => void setRadar({ radarSound: e.currentTarget.checked })} />
          <span>音效（縮放按鈕、靠近熱點時嗶嗶）</span>
        </label>
        <label class="toggle">
          <input type="checkbox" checked={app.settings.radarTilt} onChange={(e) => void setRadar({ radarTilt: e.currentTarget.checked })} />
          <span>體感：傾斜手機時雷達跟著立體轉動（純好玩）</span>
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            checked={app.settings.radarRecordButton}
            onChange={(e) => void setRadar({ radarRecordButton: e.currentTarget.checked })}
          />
          <span>雷達頁顯示記錄按鈕（接單、上客、下客，不用切回記錄頁）</span>
        </label>
        <p class="muted small">資訊卡的龍珠梗多久換一句</p>
        <div class="chips">
          {(
            [
              [30, '30 秒'],
              [60, '1 分鐘'],
              [120, '2 分鐘'],
              [300, '5 分鐘'],
              [600, '10 分鐘'],
              [0, '不顯示'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              class={app.settings.memeIntervalSec === k ? 'chip active' : 'chip'}
              onClick={() => void setRadar({ memeIntervalSec: k })}
            >
              {label}
            </button>
          ))}
        </div>
        <p class="muted small">縮放按鈕的位置</p>
        <div class="chips">
          {(
            [
              ['bl', '左下'],
              ['bc', '正下方'],
              ['br', '右下'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              class={app.settings.radarCorner === k ? 'chip active' : 'chip'}
              onClick={() => void setRadar({ radarCorner: k })}
            >
              {label}
            </button>
          ))}
        </div>
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

      <VideoImportCard />

      <UberImportCard />

      <section class="card">
        <h2>開發模式</h2>
        <p class="muted">
          假資料：以目前位置為中心產生 60 天的模擬記錄，讓雷達和統計頁有東西看。假資料不會備份到 Google Drive，可以單獨清除，不會動到真實記錄。
          {fakeCount > 0 && `目前有 ${fakeCount} 筆假事件。`}
        </p>
        <div class="btn-col">
          <button type="button" class="btn secondary" disabled={busy} onClick={() => void doFake()}>
            產生假資料
          </button>
          {fakeCount > 0 && (
            <button type="button" class="btn secondary" disabled={busy} onClick={() => void doClearFake()}>
              清除假資料
            </button>
          )}
        </div>
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
