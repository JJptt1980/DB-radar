import { useEffect, useMemo, useState } from 'preact/hooks';
import type { EventType, ImportedTrip, TripEvent } from '../db/types';
import { avgRecentFare, estimateUnpriced, fitFareModel, withOfficialFares } from '../analytics/officialFares';
import { getAllImportedTrips, getShiftTracks } from '../db/db';
import { PRODUCT_LABEL, type Product } from '../analytics/uberRates';
import { EVENT_LABEL, STATE_LABEL, allowedActions, liveEvents, shiftSummary } from '../domain/state';
import { fmtDuration, fmtTime, startOfTaipeiDay } from '../domain/time';
import { needsBackupReminder } from '../backup/policy';
import { gpsStatus, lastFix, onFix, onGpsStatus } from '../sensors/gps';
import { useWakeLock } from '../sensors/wakeLock';
import { Dialog } from './Dialog';
import { EventEditor, REASON_LABEL } from './EventEditor';
import { FareForm } from './FareForm';
import { memeAt } from './memes';
import {
  DECLINE_PROMPT_MS,
  UNDO_MS,
  backupByUser,
  dismissDeclinePrompt,
  openFareForm,
  press,
  setTripProduct,
  setDeclineReason,
  undoLast,
  useAppState,
} from './store';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useGps() {
  const [, force] = useState(0);
  useEffect(() => {
    const a = onGpsStatus(() => force((n) => n + 1));
    const b = onFix(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, []);
  return { status: gpsStatus(), fix: lastFix() };
}

const BUTTON_TEXT: Record<EventType, string> = {
  online: '上線',
  accept: '接單',
  pickup: '上客',
  dropoff: '下客',
  cancel: '訂單取消',
  offer_declined: '拒單',
  offline: '下線',
};

const PRIMARY: EventType[] = ['online', 'accept', 'pickup', 'dropoff'];

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;

export function RecordPage() {
  const app = useAppState();
  // 計時器每秒跳一次，但剛按下按鈕時 state 已比 tick 新，取兩者較大避免出現負數
  const now = Math.max(useNow(1_000), Date.now());
  const gps = useGps();
  const [editing, setEditing] = useState<TripEvent | null>(null);
  const [showPending, setShowPending] = useState(false);
  const { state, shiftId, since } = app.status;

  useWakeLock(true);

  // 按下去的回饋：短震動＋光圈擴散（換 key 讓動畫每次重播）
  const [pulse, setPulse] = useState(0);
  const tap = () => {
    try {
      navigator.vibrate?.(40);
    } catch {
      // 不支援震動就算了
    }
    setPulse((n) => n + 1);
  };
  const askFare = app.settings.askFare;

  const actions = allowedActions(state);
  const primary = actions.filter((a) => PRIMARY.includes(a));
  const secondary = actions.filter((a) => !PRIMARY.includes(a));

  // 官方資料：補上已對到的車資，還沒對到的用最近的平均實收估
  const [official, setOfficial] = useState<ImportedTrip[]>([]);
  useEffect(() => {
    void getAllImportedTrips().then((t) => setOfficial(t.filter((x) => x.source === 'uber_zip')));
  }, [app.events.length]);
  const fares = useMemo(() => withOfficialFares(app.events, app.fares, official), [app.events, app.fares, official]);
  const avgFare = useMemo(() => avgRecentFare(official, Date.now()), [official]);
  const fareModel = useMemo(() => fitFareModel(official, Date.now()), [official]);
  const summary = shiftId ? shiftSummary(app.events, fares, shiftId, now) : null;
  const estimated = summary && summary.unpriced > 0;
  // 沒有車資的趟：用這趟上客到下客的分鐘數估（官方資料擬合），沒有載客時間才用平均
  const [tracks, setTracks] = useState<{ ts: number; lat: number; lon: number }[]>([]);
  useEffect(() => {
    if (shiftId) void getShiftTracks(shiftId).then(setTracks);
  }, [shiftId, app.events.length]);
  const unpricedEst =
    summary && shiftId && summary.unpriced ? estimateUnpriced(app.events, fares, shiftId, fareModel, avgFare, tracks) : 0;
  // 目前這趟的接單事件（前往接客、載客中才有），用來選車種
  const currentAccept =
    state === 'enroute' || state === 'ontrip'
      ? [...app.events].filter((e) => !e.deleted && e.type === 'accept').sort((x, y) => y.ts - x.ts)[0] ?? null
      : null;
  const earningsShown = summary ? summary.earnings + (unpricedEst ?? 0) : 0;
  const hours = summary ? summary.onlineMs / 3_600_000 : 0;
  const hourlyShown = summary && hours >= 0.05 && unpricedEst != null ? earningsShown / hours : null;

  const live = useMemo(() => liveEvents(app.events), [app.events]);
  const today = useMemo(() => {
    const start = startOfTaipeiDay(Date.now());
    return live.filter((e) => e.ts >= start).reverse();
  }, [live]);
  const evById = useMemo(() => new Map(live.map((e) => [e.id, e])), [live]);
  const pending = useMemo(
    () =>
      [...app.fares.values()]
        .filter((f) => f.pending && !f.deleted && evById.has(f.id))
        .sort((a, b) => evById.get(a.id)!.ts - evById.get(b.id)!.ts),
    [app.fares, evById],
  );

  const undo = app.undo && now - app.undo.at < UNDO_MS ? app.undo : null;
  const decline = app.declinePrompt && now - app.declinePrompt.at < DECLINE_PROMPT_MS ? app.declinePrompt : null;
  useEffect(() => {
    if (app.declinePrompt && !decline) dismissDeclinePrompt();
  }, [app.declinePrompt, decline]);

  // 沒有車資記錄（關掉「下客後填車資」時）也能事後補填
  const fareFor = app.fareFormFor
    ? (app.fares.get(app.fareFormFor) ?? { id: app.fareFormFor, fare: null, surge: null, tip: null, note: '', pending: false, updatedAt: 0 })
    : null;

  const notice = app.notice && now - app.notice.at < 8_000 ? app.notice : null;
  const meta = app.backup;
  const firstDataAt = live[0]?.ts ?? null;
  const backupWarn =
    state !== 'offline'
      ? null
      : meta?.pending
        ? '有資料還沒備份到 Google Drive'
        : needsBackupReminder(meta?.lastBackupAt ?? null, firstDataAt, now)
          ? meta?.linked
            ? '超過 3 天沒有備份到 Google Drive'
            : '還沒設定 Google Drive 備份'
          : null;
  const [backingUp, setBackingUp] = useState(false);

  if (!app.loaded) return <p class="muted">載入中…</p>;

  return (
    <div class="record">
      <section class={`status status-${state}`}>
        <div class="status-main">
          {STATE_LABEL[state]}
          {since != null && state !== 'offline' && <span class="status-time"> {fmtDuration(now - since)}</span>}
        </div>
        {summary && (
          <div class="summary">
            <div>
              <b>{summary.trips}</b>
              <span>趟</span>
            </div>
            <div>
              <b>{unpricedEst == null ? '—' : money(earningsShown)}</b>
              <span>{estimated ? '實收（估）' : '實收'}</span>
            </div>
            <div>
              <b>{hourlyShown == null ? '—' : money(hourlyShown)}</b>
              <span>{estimated ? '時薪（估）' : '時薪'}</span>
            </div>
          </div>
        )}
        <GpsLine status={gps.status} accuracy={gps.fix?.accuracy ?? null} />
      </section>

      {/* 下線時看的是記錄頁（雷達頁沒有下線按鈕），龍珠梗就放這裡 */}
      {state === 'offline' && app.settings.memeEnabled && (
        <div class="meme-line" key={memeAt('offline', now, app.settings.memeIntervalSec)}>
          {memeAt('offline', now, app.settings.memeIntervalSec)}
        </div>
      )}

      {notice && <section class={notice.bad ? 'toast warn-toast' : 'toast'}>{notice.text}</section>}

      {backupWarn && (
        <section class="toast warn-toast">
          <span>{backupWarn}</span>
          {meta?.linked ? (
            <button
              type="button"
              class="chip"
              disabled={backingUp}
              onClick={() => {
                setBackingUp(true);
                void backupByUser().finally(() => setBackingUp(false));
              }}
            >
              {backingUp ? '備份中…' : '現在備份'}
            </button>
          ) : (
            <a class="chip link-chip" href="#settings">
              去設定
            </a>
          )}
        </section>
      )}

      <section class="actions">
        {primary.map((a) => (
          <button
            key={`${a}-${pulse}`}
            type="button"
            class={`ritual act-${a}${pulse ? ' pulse' : ''}`}
            onClick={() => {
              tap();
              void press(a);
            }}
          >
            <span class="ritual-label">{BUTTON_TEXT[a]}</span>
          </button>
        ))}
        {secondary.length > 0 && (
          <div class="btn-row">
            {secondary.map((a) => (
              <button
                key={a}
                type="button"
                class={`btn secondary act-${a}`}
                onClick={() => {
                  tap();
                  void press(a);
                }}
              >
                {BUTTON_TEXT[a]}
              </button>
            ))}
          </div>
        )}
      </section>

      {currentAccept && (
        <section class="product-row">
          {(Object.keys(PRODUCT_LABEL) as Product[]).map((p) => (
            <button
              key={p}
              type="button"
              class={(currentAccept.product ?? 'standard') === p ? 'chip active' : 'chip'}
              onClick={() => void setTripProduct(currentAccept.id, p)}
            >
              {PRODUCT_LABEL[p]}
            </button>
          ))}
        </section>
      )}

      {decline && (
        <section class="toast">
          <span>拒單理由？</span>
          <div class="chips">
            {(Object.keys(REASON_LABEL) as (keyof typeof REASON_LABEL)[]).map((r) => (
              <button key={r} type="button" class="chip" onClick={() => void setDeclineReason(decline.eventId, r)}>
                {REASON_LABEL[r]}
              </button>
            ))}
          </div>
        </section>
      )}

      {undo && (
        <section class="toast">
          <span>已記錄「{EVENT_LABEL[undo.label as EventType]}」</span>
          <button type="button" class="chip" onClick={() => void undoLast()}>
            復原（{Math.ceil((UNDO_MS - (now - undo.at)) / 1000)}）
          </button>
        </section>
      )}

      {askFare && pending.length > 0 && (
        <button type="button" class="btn secondary pending-btn" onClick={() => setShowPending(true)}>
          待補車資 {pending.length} 筆
        </button>
      )}

      <section class="events">
        <h2>今天的事件</h2>
        {today.length === 0 && <p class="muted">今天還沒有記錄。</p>}
        <ul>
          {today.map((e) => {
            const f = e.type === 'dropoff' ? app.fares.get(e.id) : undefined;
            return (
              <li key={e.id}>
                <button type="button" class="event-row" onClick={() => setEditing(e)}>
                  <span class="event-time">{fmtTime(e.ts)}</span>
                  <span class="event-type">
                    {EVENT_LABEL[e.type]}
                    {e.declineReason && `・${REASON_LABEL[e.declineReason]}`}
                  </span>
                  <span class="event-extra">
                    {f && (f.pending ? <em>待補</em> : f.fare != null ? money(f.fare + (f.tip ?? 0)) : '')}
                    {e.lat == null && <em>無定位</em>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {editing && <EventEditor event={editing} onClose={() => setEditing(null)} />}

      {fareFor && (
        <FareForm
          fare={fareFor}
          dropoffTs={evById.get(fareFor.id)?.ts ?? null}
          onClose={() => openFareForm(null)}
        />
      )}

      {showPending && (
        <Dialog title="待補車資" onClose={() => setShowPending(false)}>
          {pending.length === 0 && <p class="muted">都補完了。</p>}
          <ul class="list">
            {pending.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  class="event-row"
                  onClick={() => {
                    setShowPending(false);
                    openFareForm(f.id);
                  }}
                >
                  <span class="event-time">{fmtTime(evById.get(f.id)!.ts)}</span>
                  <span class="event-type">下客</span>
                  <span class="event-extra">
                    {new Date(evById.get(f.id)!.ts).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}

function GpsLine(props: { status: string; accuracy: number | null }) {
  const text =
    props.status === 'ok' && props.accuracy != null
      ? `定位精度 ±${Math.round(props.accuracy)} 公尺`
      : props.status === 'denied'
        ? '定位權限被拒絕，請到 Chrome 網站設定開啟'
        : props.status === 'unsupported'
          ? '這個瀏覽器不支援定位'
          : props.status === 'unavailable'
            ? '暫時拿不到定位'
            : '定位中…';
  const bad = props.status !== 'ok' || (props.accuracy ?? 0) > 100;
  return <div class={bad ? 'gps bad' : 'gps'}>{text}</div>;
}
