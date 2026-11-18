import { useState } from 'preact/hooks';
import type { DeclineReason, TripEvent } from '../db/types';
import { EVENT_LABEL } from '../domain/state';
import { fromLocalInput, toLocalInput } from '../domain/time';
import { lastFix } from '../sensors/gps';
import { Dialog } from './Dialog';
import { deleteEvent, openFareForm, updateEvent } from './store';

export const REASON_LABEL: Record<Exclude<DeclineReason, null>, string> = {
  too_far: '太遠',
  low_fare: '車資低',
  wrong_direction: '方向不對',
};

export function EventEditor(props: { event: TripEvent; onClose: () => void }) {
  const e = props.event;
  const [time, setTime] = useState(toLocalInput(e.ts));
  const [lat, setLat] = useState(e.lat == null ? '' : String(e.lat));
  const [lon, setLon] = useState(e.lon == null ? '' : String(e.lon));
  const [acc, setAcc] = useState<number | null>(e.accuracy);
  const [reason, setReason] = useState<DeclineReason>(e.declineReason ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const useHere = () => {
    const f = lastFix();
    if (!f) {
      setError('還沒拿到定位');
      return;
    }
    setLat(f.lat.toFixed(6));
    setLon(f.lon.toFixed(6));
    setAcc(Math.round(f.accuracy));
    setError('');
  };

  const save = async () => {
    const ts = fromLocalInput(time);
    if (ts == null) return setError('時間格式不對');
    const la = lat.trim() === '' ? null : Number(lat);
    const lo = lon.trim() === '' ? null : Number(lon);
    if ((la == null) !== (lo == null)) return setError('緯度和經度要一起填，或一起留空');
    if (la != null && (!Number.isFinite(la) || Math.abs(la) > 90)) return setError('緯度不對');
    if (lo != null && (!Number.isFinite(lo) || Math.abs(lo) > 180)) return setError('經度不對');
    const moved = la !== e.lat || lo !== e.lon;
    const next: TripEvent = {
      ...e,
      ts,
      lat: la,
      lon: lo,
      accuracy: moved ? acc : e.accuracy,
    };
    if (e.type === 'offer_declined') next.declineReason = reason;
    await updateEvent(next);
    props.onClose();
  };

  return (
    <Dialog title={`編輯「${EVENT_LABEL[e.type]}」`} onClose={props.onClose}>
      <div class="form">
        <label class="field">
          <span>時間</span>
          <input type="datetime-local" step={1} value={time} onInput={(ev) => setTime(ev.currentTarget.value)} />
        </label>
        <div class="field-row">
          <label class="field">
            <span>緯度</span>
            <input inputMode="decimal" value={lat} onInput={(ev) => setLat(ev.currentTarget.value)} />
          </label>
          <label class="field">
            <span>經度</span>
            <input inputMode="decimal" value={lon} onInput={(ev) => setLon(ev.currentTarget.value)} />
          </label>
        </div>
        <button type="button" class="btn secondary" onClick={useHere}>
          改成目前位置
        </button>
        {e.type === 'offer_declined' && (
          <div class="field">
            <span>拒單理由</span>
            <div class="chips">
              {(Object.keys(REASON_LABEL) as (keyof typeof REASON_LABEL)[]).map((r) => (
                <button
                  type="button"
                  key={r}
                  class={reason === r ? 'chip active' : 'chip'}
                  onClick={() => setReason(reason === r ? null : r)}
                >
                  {REASON_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
        )}
        {e.type === 'dropoff' && (
          <button
            type="button"
            class="btn secondary"
            onClick={() => {
              props.onClose();
              openFareForm(e.id);
            }}
          >
            編輯車資
          </button>
        )}
        {error && <p class="error">{error}</p>}
        <div class="btn-row">
          {confirmDelete ? (
            <button
              type="button"
              class="btn danger"
              onClick={() => void deleteEvent(e.id).then(props.onClose)}
            >
              確定刪除
            </button>
          ) : (
            <button type="button" class="btn secondary" onClick={() => setConfirmDelete(true)}>
              刪除
            </button>
          )}
          <button type="button" class="btn primary" onClick={() => void save()}>
            儲存
          </button>
        </div>
      </div>
    </Dialog>
  );
}
