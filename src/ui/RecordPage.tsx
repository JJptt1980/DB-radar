import { useEffect, useMemo, useState } from 'preact/hooks';
import type { EventType, TripEvent } from '../db/types';
import { EVENT_LABEL, STATE_LABEL, allowedActions, liveEvents, shiftSummary } from '../domain/state';
import { fmtDuration, fmtTime, startOfTaipeiDay } from '../domain/time';
import { gpsStatus, lastFix, onFix, onGpsStatus } from '../sensors/gps';
import { useWakeLock } from '../sensors/wakeLock';
import { Dialog } from './Dialog';
import { EventEditor, REASON_LABEL } from './EventEditor';
import { FareForm } from './FareForm';
import {
  DECLINE_PROMPT_MS,
  UNDO_MS,
  dismissDeclinePrompt,
  openFareForm,
  press,
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

  const actions = allowedActions(state);
  const primary = actions.filter((a) => PRIMARY.includes(a));
  const secondary = actions.filter((a) => !PRIMARY.includes(a));

  const summary = shiftId ? shiftSummary(app.events, app.fares, shiftId, now) : null;

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

  const fareFor = app.fareFormFor ? app.fares.get(app.fareFormFor) : null;

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
              <b>{money(summary.earnings)}</b>
              <span>實收</span>
            </div>
            <div>
              <b>{summary.hourly == null ? '—' : money(summary.hourly)}</b>
              <span>時薪</span>
            </div>
          </div>
        )}
        <GpsLine status={gps.status} accuracy={gps.fix?.accuracy ?? null} />
      </section>

      <section class="actions">
        {primary.map((a) => (
          <button key={a} type="button" class={`btn big act-${a}`} onClick={() => void press(a)}>
            {BUTTON_TEXT[a]}
          </button>
        ))}
        {secondary.length > 0 && (
          <div class="btn-row">
            {secondary.map((a) => (
              <button key={a} type="button" class={`btn secondary act-${a}`} onClick={() => void press(a)}>
                {BUTTON_TEXT[a]}
              </button>
            ))}
          </div>
        )}
      </section>

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

      {pending.length > 0 && (
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
