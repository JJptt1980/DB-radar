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

  // 加成已含在車資內（SPEC 8.4），加成比車資大一定是填錯：提示但不擋存檔，存檔時維持待補
  const surgeTooBig = (toNum(surge) ?? 0) > (toNum(fare) ?? Infinity);

  const save = (pending: boolean) =>
    saveFare({
      id: f.id,
      fare: toNum(fare),
      surge: toNum(surge),
      tip: toNum(tip),
      note: note.trim(),
      pending: pending || toNum(fare) == null || surgeTooBig,
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
          <span>車資（Uber 顯示金額，含加成）</span>
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
          <label class={surgeTooBig ? 'field invalid' : 'field'}>
            <span>加成</span>
            <input inputMode="numeric" value={surge} onInput={(e) => setSurge(e.currentTarget.value)} placeholder="0" />
            <small>已含在車資內，只做紀錄，不會重複加總</small>
          </label>
          <label class="field">
            <span>小費</span>
            <input inputMode="numeric" value={tip} onInput={(e) => setTip(e.currentTarget.value)} placeholder="0" />
          </label>
        </div>
        {surgeTooBig && <p class="error">加成不能大於車資，車資請填 Uber 顯示的總額</p>}
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
