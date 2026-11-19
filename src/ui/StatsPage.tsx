// 統計頁（SPEC 5.3 Phase 3）：表格版。地圖熱力圖是 Phase 4。
import type { ComponentType } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { StatsIndex } from '../analytics/stats';
import { slotLabel } from '../analytics/slots';
import { bestCells, bestSlots, declineStats, monthly, weekly, type Period } from '../analytics/summary';
import { bearingDeg, compassLabel, distanceM } from '../domain/geo';
import { lastFix } from '../sensors/gps';
import { useAppState } from './store';
import { useAnalytics } from './useAnalytics';

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;
const CONF = { low: '低', mid: '中', high: '高' } as const;
const REASON = { too_far: '太遠', low_fare: '車資低', wrong_direction: '方向不對', none: '沒選理由' } as const;

export function StatsPage() {
  const app = useAppState();
  const { index, loading, official, fares } = useAnalytics();
  const now = Date.now();
  const from = lastFix() ?? app.settings.homeCenter;

  const data = useMemo(() => {
    if (!index) return null;
    return {
      slots: bestSlots(index, app.settings),
      cells: bestCells(index, app.settings),
      weeks: weekly(app.events, fares ?? app.fares, app.settings, now, 8, official ?? undefined),
      month: monthly(app.events, fares ?? app.fares, app.settings, now, official ?? undefined)[0] ?? null,
      decline: declineStats(app.events),
    };

  }, [index, official, fares, app.events, app.fares, app.settings]);

  const [view, setView] = useState<'map' | 'table'>(() => {
    try {
      return localStorage.getItem('dbradar-stats-view') === 'table' ? 'table' : 'map';
    } catch {
      return 'map';
    }
  });
  const choose = (v: 'map' | 'table') => {
    setView(v);
    try {
      localStorage.setItem('dbradar-stats-view', v);
    } catch {
      // 記不住就算了
    }
  };

  if (!data || !index) return <p class="muted">{loading ? '計算中…' : '還沒有資料'}</p>;

  const switcher = (
    <div class="radio-row seg">
      <button type="button" class={view === 'map' ? 'chip active' : 'chip'} onClick={() => choose('map')}>
        地圖
      </button>
      <button type="button" class={view === 'table' ? 'chip active' : 'chip'} onClick={() => choose('table')}>
        表格
      </button>
    </div>
  );

  if (view === 'map') {
    return (
      <div class="stats">
        {switcher}
        <MapLoader index={index} />
      </div>
    );
  }

  return (
    <div class="stats">
      {switcher}
      <section class="card">
        <h2>本月總覽</h2>
        {data.month ? <MonthCard p={data.month} /> : <p class="muted">這個月還沒有記錄。</p>}
      </section>

      <section class="card">
        <h2>每週時薪</h2>
        {data.weeks.length === 0 ? (
          <p class="muted">還沒有完整的班。</p>
        ) : (
          <table class="tbl">
            <thead>
              <tr>
                <th>週（週一）</th>
                <th>趟</th>
                <th>實收</th>
                <th>時薪</th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.key}>
                  <td>{w.key.slice(5)}</td>
                  <td>{w.trips}</td>
                  <td>
                    {money(w.earnings)}
                    {w.bonus > 0 && <div class="muted small">含獎 {money(w.bonus)}</div>}
                  </td>
                  <td>{w.hourly == null ? '—' : money(w.hourly)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="card">
        <h2>最佳時段</h2>
        <p class="muted small">全城平均，不含開車過去的時間。</p>
        <table class="tbl">
          <thead>
            <tr>
              <th>時段</th>
              <th>等待</th>
              <th>每單</th>
              <th>時薪</th>
            </tr>
          </thead>
          <tbody>
            {data.slots.map((s) => (
              <tr key={s.slot}>
                <td>{slotLabel(s.slot)}</td>
                <td>{Math.round(s.waitMin)} 分</td>
                <td>{money(s.perOrder)}</td>
                <td>{money(s.hourly)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section class="card">
        <h2>最佳地點</h2>
        <p class="muted small">不分時段；方向與距離是從目前位置算。</p>
        <table class="tbl">
          <thead>
            <tr>
              <th>位置</th>
              <th>等待</th>
              <th>每單</th>
              <th>時薪</th>
            </tr>
          </thead>
          <tbody>
            {data.cells.map((c) => (
              <tr key={c.cell}>
                <td>
                  {compassLabel(bearingDeg(from, c.center))} {(distanceM(from, c.center) / 1000).toFixed(1)} km
                  <div class="muted small">
                    {c.orders.toFixed(0)} 單・信心{CONF[c.confidence]}
                  </div>
                </td>
                <td>{Math.round(c.waitMin)} 分</td>
                <td>{money(c.perOrder)}</td>
                <td>{money(c.hourly)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section class="card">
        <h2>挑單分析</h2>
        {data.decline.total === 0 ? (
          <p class="muted">還沒有拒單記錄。</p>
        ) : (
          <>
            <p>
              拒單 {data.decline.total} 次：
              {(Object.keys(REASON) as (keyof typeof REASON)[])
                .filter((k) => data.decline.byReason[k] > 0)
                .map((k) => `${REASON[k]} ${data.decline.byReason[k]}`)
                .join('、')}
            </p>
            <p>
              拒單後到下一次接單平均{' '}
              <b>{data.decline.afterDeclineWaitMin == null ? '—' : `${Math.round(data.decline.afterDeclineWaitMin)} 分鐘`}</b>
              ；一般空車到接單平均{' '}
              {data.decline.avgWaitMin == null ? '—' : `${Math.round(data.decline.avgWaitMin)} 分鐘`}。
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function MonthCard(props: { p: Period }) {
  const p = props.p;
  return (
    <div class="summary month">
      <div>
        <b>{p.trips}</b>
        <span>趟</span>
      </div>
      <div>
        <b>{money(p.earnings)}</b>
        <span>實收</span>
      </div>
      {p.bonus > 0 && (
        <div>
          <b>{money(p.bonus)}</b>
          <span>趟獎（已含在實收）</span>
        </div>
      )}
      <div>
        <b>{p.onlineHours.toFixed(1)}</b>
        <span>上線小時</span>
      </div>
      <div>
        <b>{p.hourly == null ? '—' : money(p.hourly)}</b>
        <span>時薪</span>
      </div>
      <div>
        <b>{p.fareSum > 0 ? `${((p.surge / p.fareSum) * 100).toFixed(1)}%` : '—'}</b>
        <span>加成佔收入</span>
      </div>
    </div>
  );
}

/** Leaflet 只有打開地圖時才載入 */
function MapLoader(props: { index: StatsIndex }) {
  const [Comp, setComp] = useState<ComponentType<{ index: StatsIndex }> | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    import('./HeatMap')
      .then((m) => setComp(() => m.HeatMap))
      .catch(() => setErr(true));
  }, []);
  if (err) return <p class="muted">地圖載入失敗，請確認網路後重新整理。</p>;
  return Comp ? <Comp index={props.index} /> : <p class="muted">地圖載入中…</p>;
}
