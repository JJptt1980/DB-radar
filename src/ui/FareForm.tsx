import { useState } from 'preact/hooks';
import type { Fare } from '../db/types';
import { fmtTime } from '../domain/time';
import { Dialog } from './Dialog';
import { saveFare } from './store';

const toStr = (n: number | null) => (n == null ? '' : String(n));
const toNum = (s: string): number | null => {
  const t = s.replace(/[^\d.]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function FareForm(props: { fare: Fare; dropoffTs: number | null; onClose: () => void }) {
  const f = props.fare;
  const [fare, setFare] = useState(toStr(f.fare));
  const [surge, setSurge] = useState(toStr(f.surge));
  const [tip, setTip] = useState(toStr(f.tip));
  const [note, setNote] = useState(f.note);

  const save = (pending: boolean) =>
    saveFare({
      id: f.id,
      fare: toNum(fare),
      surge: toNum(surge),
      tip: toNum(tip),
      note: note.trim(),
      pending: pending || toNum(fare) == null,
    }).then(props.onClose);

  const title = props.dropoffTs ? `${fmtTime(props.dropoffTs)} 下客的車資` : '車資';

  return (
    <Dialog title={title} onClose={() => void save(f.pending && toNum(fare) == null)}>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <label class="field">
          <span>車資（含加成）</span>
          <input
            inputMode="numeric"
            enterKeyHint="next"
            autoFocus
            value={fare}
            onInput={(e) => setFare(e.currentTarget.value)}
            placeholder="例如 250"
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span>其中加成</span>
            <input inputMode="numeric" value={surge} onInput={(e) => setSurge(e.currentTarget.value)} placeholder="0" />
          </label>
          <label class="field">
            <span>小費</span>
            <input inputMode="numeric" value={tip} onInput={(e) => setTip(e.currentTarget.value)} placeholder="0" />
          </label>
        </div>
        <label class="field">
          <span>備註</span>
          <input value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="選填" />
        </label>
        <div class="btn-row">
          <button type="button" class="btn secondary" onClick={() => void save(true)}>
            稍後再填
          </button>
          <button type="submit" class="btn primary" disabled={toNum(fare) == null}>
            儲存
          </button>
        </div>
      </form>
    </Dialog>
  );
}
