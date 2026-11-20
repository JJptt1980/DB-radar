// 設定頁「Uber 官方資料匯入」（SPEC 第 7 章、8.6 第 4 點）
import { useEffect, useRef, useState } from 'preact/hooks';
import { getAllImportedIdle, getAllImportedTrips, putImported } from '../db/db';
import type { ImportedBonus, ImportedIdle, ImportedTrip } from '../db/types';
import { fmtDateKey } from '../domain/time';
import { Dialog } from './Dialog';
import { loadAll, notify, useAppState } from './store';

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;

interface Preview {
  trips: ImportedTrip[];
  idle: ImportedIdle[];
  bonus: ImportedBonus[];
  videoUpdates: ImportedTrip[];
  newTrips: number;
  newIdle: number;
  points: number;
  skipped: string[];
  summary: import('../import/uber').UberSummary;
}

export function UberImportCard() {
  const app = useAppState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [counts, setCounts] = useState<{ trips: number; idle: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ title: string; body: string } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const refresh = () =>
    void Promise.all([getAllImportedTrips(), getAllImportedIdle()]).then(([t, i]) =>
      setCounts({ trips: t.filter((x) => x.source === 'uber_zip').length, idle: i.length }),
    );
  useEffect(refresh, [app.events]);

  const choose = async (f: File) => {
    setStatus('解壓縮中…');
    try {
      const [{ parseUberZip }, uber] = await Promise.all([import('../import/uberZip'), import('../import/uber')]);
      const r = await parseUberZip(f, setStatus);
      setStatus('比對既有資料…');
      const [existingTrips, existingIdle] = await Promise.all([getAllImportedTrips(), getAllImportedIdle()]);
      const tripIds = new Set(existingTrips.map((t) => t.id));
      const idleIds = new Set(existingIdle.map((t) => t.id));
      const videos = existingTrips.filter((t) => t.source === 'video');
      setPreview({
        trips: r.trips,
        idle: r.idle,
        bonus: r.bonus,
        videoUpdates: uber.matchVideoTrips(videos, r.trips, Date.now()),
        newTrips: r.trips.filter((t) => !tripIds.has(t.id)).length,
        newIdle: r.idle.filter((t) => !idleIds.has(t.id)).length,
        points: r.points,
        skipped: r.skipped,
        summary: uber.summarize(r.trips, r.idle, r.points, r.bonus),
      });
    } catch (e) {
      setMsg({ title: '無法匯入', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setStatus(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!preview) return;
    setStatus('寫入中…');
    try {
      // id 由時間決定，重複匯入新的下載檔只會覆蓋同一筆，不會重複
      await putImported([...preview.trips, ...preview.videoUpdates], preview.idle, preview.bonus);
      await loadAll();
      refresh();
      setMsg({
        title: '匯入完成',
        body: `行程：新增 ${preview.newTrips} 趟（共 ${preview.trips.length} 趟）\n空車時段：新增 ${preview.newIdle} 段（共 ${preview.idle.length} 段）${
          preview.bonus.length ? `\n趟獎與其他獎勵：${preview.bonus.length} 筆` : ''
        }${
          preview.videoUpdates.length ? `\n影片行程補上準確時間：${preview.videoUpdates.length} 趟` : ''
        }`,
      });
      notify('已匯入 Uber 官方資料');
      setPreview(null);
    } finally {
      setStatus(null);
    }
  };

  const s = preview?.summary;

  return (
    <section class="card">
      <h2>Uber 官方資料匯入</h2>
      <p class="muted">
        在 Uber App 申請「下載你的資料」，收到 zip 後在這裡選檔。只讀行程、上線狀態、App 定位和獎勵四個檔案；帳號、付款、客服等其他檔案不會載入。
        {counts && (counts.trips || counts.idle) ? ` 已匯入 ${counts.trips} 趟、${counts.idle} 段空車時段。` : ''}
      </p>
      <p class="muted small">
        Uber 只保留最近 30 天的定位，雷達靠它知道你在哪裡接到單。建議每個月下載一次，資料才接得上。
      </p>
      <button type="button" class="btn secondary" disabled={!!status} onClick={() => fileRef.current?.click()}>
        {status ?? '選擇 Uber 資料 zip'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) void choose(f);
        }}
      />

      {preview && s && (
        <Dialog title="Uber 資料預覽" onClose={() => setPreview(null)}>
          <dl class="facts">
            <dt>期間</dt>
            <dd>
              {s.firstTs ? fmtDateKey(s.firstTs) : '—'} ～ {s.lastTs ? fmtDateKey(s.lastTs) : '—'}
            </dd>
            <dt>完成的行程</dt>
            <dd>
              {s.trips} 趟（新的 {preview.newTrips} 趟）
            </dd>
            <dt>司機實收</dt>
            <dd>{money(s.earnings)}</dd>
            {s.quests > 0 && (
              <>
                <dt>趟獎</dt>
                <dd>
                  {s.quests} 筆、{money(s.questTotal)}
                </dd>
              </>
            )}
            {s.feeDiscountTotal > 0 && (
              <>
                <dt>服務費折扣</dt>
                <dd>{money(s.feeDiscountTotal)}</dd>
              </>
            )}
            <dt>空車時段</dt>
            <dd>
              {s.idlePeriods} 段、{Math.round(s.idleHours)} 小時（新的 {preview.newIdle} 段）
            </dd>
            <dt>有定位的</dt>
            <dd>
              {s.withPath} 段，接單位置會算進雷達的熱點（Uber 只保留最近 30 天）
            </dd>
            {preview.videoUpdates.length > 0 && (
              <>
                <dt>影片行程</dt>
                <dd>{preview.videoUpdates.length} 趟會補上準確的上下客時間</dd>
              </>
            )}
          </dl>
          <p class="muted small">
            趟獎和服務費折扣算進每週、每月的實收與時薪，不影響雷達推薦的地點。沒有定位的空車時段只用來判斷「哪個時段好」；有定位的會和自己按按鈕的記錄一起算「在哪裡好」。和按鈕記錄重疊的時段不會重複計算。
          </p>
          <button type="button" class="btn secondary" onClick={() => setShowSkipped((v) => !v)}>
            {showSkipped ? '收起' : `沒有讀的檔案（${preview.skipped.length}）`}
          </button>
          {showSkipped && (
            <ul class="list small muted">
              {preview.skipped.map((n) => (
                <li key={n}>{n.split('/').pop()}</li>
              ))}
            </ul>
          )}
          <div class="btn-row">
            <button type="button" class="btn secondary" onClick={() => setPreview(null)}>
              取消
            </button>
            <button type="button" class="btn primary" disabled={!!status} onClick={() => void doImport()}>
              {status ?? '匯入'}
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
    </section>
  );
}
