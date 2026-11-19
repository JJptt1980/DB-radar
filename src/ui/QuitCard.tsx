// 收工建議（SPEC 4.5.2）：記錄頁一張卡，雷達頁一行小字。
import { useMemo } from 'preact/hooks';
import { MIN_TRIPS } from '../analytics/model';
import { quitAdvice, WEAK_RATIO, type QuitAdvice } from '../analytics/quit';
import { useAnalytics } from './useAnalytics';
import { useAppState } from './store';

const TEN_MIN = 600_000;
const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;

/** 上線中、資料夠才有建議；每 10 分鐘（或資料、設定變了）重算一次 */
export function useQuitAdvice(now: number): QuitAdvice | null {
  const app = useAppState();
  const { index } = useAnalytics();
  const bucket = Math.floor(now / TEN_MIN);
  const online = app.status.shiftId != null;
  return useMemo(() => {
    if (!online || !index || index.tripCount < MIN_TRIPS) return null;
    return quitAdvice(index, app.settings, Math.max(bucket * TEN_MIN, Date.now()));
  }, [online, index, app.settings, bucket]);
}

export function QuitCard({ advice }: { advice: QuitAdvice }) {
  const max = Math.max(advice.avg, ...advice.hours.map((h) => h.hourly ?? 0)) * 1.1;
  const avgPct = (advice.avg / max) * 100;
  return (
    <section class={`quit quit-${advice.verdict}`}>
      <div class="quit-title">收工建議</div>
      <div class="quit-text">{advice.text}</div>
      <div class="quit-bars" style={{ '--avg': `${avgPct}%` }} aria-label="接下來幾小時的預估時薪">
        {advice.hours.map((h, i) => (
          <div class="quit-col" key={i}>
            <span class="quit-val">{h.hourly == null ? '—' : money(h.hourly)}</span>
            <div class="quit-track">
              {h.hourly != null && (
                <div
                  class={h.hourly >= advice.avg * WEAK_RATIO ? 'quit-bar' : 'quit-bar weak'}
                  style={{ height: `${(h.hourly / max) * 100}%` }}
                />
              )}
            </div>
            <span class="quit-hour">{i === 0 ? '現在' : `${h.hour} 點`}</span>
          </div>
        ))}
      </div>
      <div class="quit-legend">虛線是你平常的平均 {money(advice.avg)}／時・只用你自己的資料</div>
    </section>
  );
}
