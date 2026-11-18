// 設定頁「行程影片匯入」（SPEC 8.6）：選檔 → 預覽 → 匯入 → 補待補車資
import { useEffect, useRef, useState } from 'preact/hooks';
import { readMaybeGzip } from '../backup/localFile';
import { getAllImportedTrips, putImportedTrips } from '../db/db';
import type { GeoPrecision } from '../db/types';
import { BackupFormatError } from '../domain/merge';
import { fmtTime } from '../domain/time';
import {
  PRECISION_LABEL,
  parseVideoImport,
  planVideoImport,
  type FareSuggestion,
  type VideoImportFile,
  type VideoImportPlan,
} from '../import/video';
import { Dialog } from './Dialog';
import { getState, saveFare, useAppState } from './store';

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;

export function VideoImportCard() {
  const app = useAppState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ file: VideoImportFile; plan: VideoImportPlan } | null>(null);
  const [suggest, setSuggest] = useState<FareSuggestion[]>([]);
  const [msg, setMsg] = useState<{ title: string; body: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => void getAllImportedTrips().then((t) => setCount(t.length));
  useEffect(refresh, [app.events]);

  const choose = async (f: File) => {
    try {
      const file = parseVideoImport(JSON.parse(await readMaybeGzip(f)));
      const s = getState();
      const plan = planVideoImport(file, await getAllImportedTrips(), s.events, s.fares, Date.now());
      setPreview({ file, plan });
    } catch (e) {
      setMsg({
        title: '無法匯入',
        body: e instanceof BackupFormatError ? e.message : e instanceof SyntaxError ? '讀不懂這個檔案' : String(e),
      });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await putImportedTrips(preview.plan.toAdd);
      const { plan } = preview;
      setPreview(null);
      refresh();
      if (plan.fareSuggestions.length) setSuggest(plan.fareSuggestions);
      else
        setMsg({
          title: '匯入完成',
          body: `新增 ${plan.toAdd.length} 趟${plan.skipped ? `，${plan.skipped} 趟之前已匯入過` : ''}${
            plan.matched ? `，${plan.matched} 趟對應到按鈕記錄` : ''
          }。`,
        });
    } finally {
      setBusy(false);
    }
  };

  const applySuggestion = async (s: FareSuggestion) => {
    const f = getState().fares.get(s.eventId);
    if (f) await saveFare({ ...f, fare: s.fare, surge: s.surge, pending: false });
    setSuggest((list) => list.filter((x) => x.eventId !== s.eventId));
  };

  const evTs = (id: string) => getState().events.find((e) => e.id === id)?.ts;

  return (
    <section class="card">
      <h2>行程影片匯入</h2>
      <p class="muted">
        把 Uber「行程費用紀錄」的螢幕錄影用 Mac 匯入器轉成 radar-video-….json，再在這裡選檔。已匯入 {count ?? '…'} 趟。
      </p>
      <div class="btn-col">
        <button type="button" class="btn secondary" onClick={() => fileRef.current?.click()}>
          選擇影片匯入檔
        </button>
        <button type="button" class="btn secondary" onClick={() => setShowHelp(true)}>
          怎麼錄影？
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.gz,application/json"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) void choose(f);
        }}
      />

      {showHelp && (
        <Dialog title="怎麼錄影" onClose={() => setShowHelp(false)}>
          <ol class="steps">
            <li>Uber Driver →「行程費用紀錄」，先用上方的日期篩選器選好日期，再開始螢幕錄影。</li>
            <li>以穩定速度往下滑，每次大約半個螢幕，讓每張卡片完整停留至少半秒。</li>
            <li>一直滑到出現「…之間的活動結束」才停。</li>
            <li>錄影時不要點開卡片，也避免通知遮住畫面。</li>
            <li>把影片傳到 Mac，執行匯入器，再把產生的 .json 傳回手機。</li>
          </ol>
          <button type="button" class="btn primary" onClick={() => setShowHelp(false)}>
            知道了
          </button>
        </Dialog>
      )}

      {preview && <Preview preview={preview} busy={busy} onCancel={() => setPreview(null)} onImport={doImport} />}

      {suggest.length > 0 && (
        <Dialog title="補上待補的車資？" onClose={() => setSuggest([])}>
          <p class="muted">這些行程在記錄頁還是「待補車資」，影片裡有讀到車資。</p>
          <ul class="list">
            {suggest.map((s) => {
              const ts = evTs(s.eventId);
              return (
                <li key={s.eventId} class="suggest-row">
                  <span>
                    {ts ? `${fmtTime(ts)} 下客：` : ''}用影片的車資 {money(s.fare)}
                    {s.surge ? `（含加成 ${money(s.surge)}）` : ''}補上？
                  </span>
                  <button type="button" class="chip" onClick={() => void applySuggestion(s)}>
                    補上
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" class="btn secondary" onClick={() => setSuggest([])}>
            先不要
          </button>
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

function Preview(props: {
  preview: { file: VideoImportFile; plan: VideoImportPlan };
  busy: boolean;
  onCancel: () => void;
  onImport: () => void;
}) {
  const { file, plan } = props.preview;
  const prec = (Object.entries(plan.precision) as [GeoPrecision, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${PRECISION_LABEL[k]} ${v}`)
    .join('、');
  const newIds = new Set(plan.toAdd.map((t) => t.id));
  const trips = [...file.trips].sort((a, b) => (a.pickupTs ?? 0) - (b.pickupTs ?? 0));
  return (
    <Dialog title="匯入預覽" onClose={props.onCancel}>
      <dl class="facts">
        <dt>日期</dt>
        <dd>{plan.dates.join('、') || '—'}</dd>
        <dt>趟數</dt>
        <dd>{plan.total} 趟</dd>
        <dt>總車資</dt>
        <dd>
          {money(plan.fareSum)}（含加成 {money(plan.surgeSum)}）
        </dd>
        <dt>地點精度</dt>
        <dd>{prec || '—'}</dd>
        {plan.lowSupport > 0 && (
          <>
            <dt>要確認</dt>
            <dd class="warn">{plan.lowSupport} 趟只在 1 張畫面讀到</dd>
          </>
        )}
        {plan.skipped > 0 && (
          <>
            <dt>已匯入過</dt>
            <dd>{plan.skipped} 趟，會略過</dd>
          </>
        )}
        {plan.matched > 0 && (
          <>
            <dt>對應按鈕記錄</dt>
            <dd>{plan.matched} 趟（按鈕的時間與 GPS 保留不動）</dd>
          </>
        )}
      </dl>
      <ul class="list trip-list">
        {trips.map((t) => (
          <li key={t.id} class={t.lowSupport ? 'low' : newIds.has(t.id) ? '' : 'dup'}>
            <div class="trip-head">
              <span>{t.raw.startLocal ?? (t.pickupTs ? fmtTime(t.pickupTs) : '')}</span>
              <span>{t.product}</span>
              <b>{money(t.fare ?? 0)}</b>
            </div>
            <div class="trip-addr">
              {t.pickupAddress} → {t.dropoffAddress}
            </div>
          </li>
        ))}
      </ul>
      <div class="btn-row">
        <button type="button" class="btn secondary" onClick={props.onCancel}>
          取消
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={props.busy || plan.toAdd.length === 0}
          onClick={props.onImport}
        >
          {plan.toAdd.length ? `匯入 ${plan.toAdd.length} 趟` : '沒有新行程'}
        </button>
      </div>
    </Dialog>
  );
}
