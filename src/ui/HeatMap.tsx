// 地圖熱力圖（SPEC 5.3 Phase 4）：Leaflet + OpenStreetMap 圖磚，H3 六角形依預期時薪上色。
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { heatCells, heatColor, scaleRange, type DayChoice, type HexCell, type HourChoice } from '../analytics/heat';
import { DAY_LABEL, DAY_TYPES, dayType, taipeiParts } from '../analytics/slots';
import type { StatsIndex } from '../analytics/stats';
import { lastFix } from '../sensors/gps';
import { useAppState } from './store';

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;
const CONF_OPACITY = { low: 0.35, mid: 0.55, high: 0.75 } as const;
const CONF_LABEL = { low: '低', mid: '中', high: '高' } as const;

export function HeatMap(props: { index: StatsIndex }) {
  const app = useAppState();
  const holidays = useMemo(() => new Set(app.settings.holidays), [app.settings.holidays]);
  const [day, setDay] = useState<DayChoice>(() => dayType(Date.now(), holidays));
  const [hour, setHour] = useState<HourChoice>(() => taipeiParts(Date.now()).hour);
  const [picked, setPicked] = useState<HexCell | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  const cells = useMemo(() => heatCells(props.index, day, hour, app.settings), [props.index, day, hour, app.settings]);
  const [lo, hi] = useMemo(() => scaleRange(cells.map((c) => c.hourly)), [cells]);

  // 建立地圖（只做一次）
  useEffect(() => {
    const f = lastFix();
    const center = f ? { lat: f.lat, lon: f.lon } : app.settings.homeCenter;
    const m = L.map(mapEl.current!, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: 'dark-tiles',
    }).addTo(m);
    if (f) {
      L.circleMarker([f.lat, f.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#ff3b30', fillOpacity: 1 }).addTo(m);
    }
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // 六角形
  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    for (const c of cells) {
      const t = hi > lo ? (c.hourly - lo) / (hi - lo) : 1;
      const color = heatColor(t);
      L.polygon(c.boundary, {
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: CONF_OPACITY[c.confidence],
      })
        .on('click', () => setPicked(c))
        .addTo(g);
    }
    setPicked(null);
  }, [cells, lo, hi]);

  const fit = () => {
    if (!cells.length || !map.current) return;
    map.current.fitBounds(L.latLngBounds(cells.flatMap((c) => c.boundary)), { padding: [24, 24] });
  };

  return (
    <div class="heat">
      <div class="chips day-chips">
        {(['all', ...DAY_TYPES] as DayChoice[]).map((d) => (
          <button key={d} type="button" class={d === day ? 'chip active' : 'chip'} onClick={() => setDay(d)}>
            {d === 'all' ? '全部' : DAY_LABEL[d]}
          </button>
        ))}
      </div>
      <div class="hour-row">
        <label class="toggle">
          <input type="checkbox" checked={hour === 'all'} onChange={(e) => setHour(e.currentTarget.checked ? 'all' : taipeiParts(Date.now()).hour)} />
          <span>全天</span>
        </label>
        {hour !== 'all' && (
          <>
            <input
              class="hour-slider"
              type="range"
              min={0}
              max={23}
              value={hour}
              onInput={(e) => setHour(Number(e.currentTarget.value))}
              aria-label="時段"
            />
            <b class="hour-label">{hour} 點</b>
          </>
        )}
      </div>

      <div ref={mapEl} class="map" />

      <div class="legend">
        <span>{money(lo)}</span>
        <div class="legend-bar" />
        <span>{money(hi)}</span>
        <span class="muted small">／時（越不透明越有把握）</span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn secondary" disabled={!cells.length} onClick={fit}>
          顯示全部熱點（{cells.length}）
        </button>
      </div>

      {picked ? (
        <section class="card">
          <dl class="facts">
            <dt>預期時薪</dt>
            <dd>{money(picked.hourly)}</dd>
            <dt>預期等待</dt>
            <dd>{Math.round(picked.waitMin)} 分鐘</dd>
            <dt>每單實收</dt>
            <dd>{money(picked.perOrder)}</dd>
            <dt>樣本</dt>
            <dd>
              空車 {picked.idleHours.toFixed(1)} 小時、{picked.orders.toFixed(0)} 單
            </dd>
            <dt>信心度</dt>
            <dd>{CONF_LABEL[picked.confidence]}</dd>
          </dl>
        </section>
      ) : (
        <p class="muted small">點六角形看細節。時薪不含開車過去的時間。</p>
      )}
      {!navigator.onLine && <p class="warn small">離線中：地圖底圖要有網路才看得到，六角形還是會顯示。</p>}
    </div>
  );
}
