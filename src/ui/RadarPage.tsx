// 雷達頁（SPEC 5.2）：圓形螢幕、方格底、黃色光點是熱點、中間紅色三角形是自己。全部自己用 Canvas 畫。
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hasEnoughData, recommend, type Candidate, type Recommendation, MIN_TRIPS } from '../analytics/model';
import { slotLabel, slotOf } from '../analytics/slots';
import { compassLabel, distanceM, type LatLon } from '../domain/geo';
import { lastFix, onFix } from '../sensors/gps';
import { useHeading } from '../sensors/heading';
import { useWakeLock } from '../sensors/wakeLock';
import { Dialog } from './Dialog';
import { clampRange, clusterDots, clusterRadius, fitRange, nearBand, nextZoom, niceStep, zoomStage, type Placed } from './radarZoom';
import { playNear, playZoom } from './radarSound';
import { allowedActions } from '../domain/state';
import type { EventType } from '../db/types';
import { press } from './store';
import { useAppState } from './store';
import { useAnalytics } from './useAnalytics';

const RECALC_MS = 30_000;
const RECALC_MOVE_M = 200;
/** 雷達上最多放幾個候選格（附近的會合成一個點） */
const MAX_DOTS = 40;
/** 螢幕上距離這麼近的點合成一個 */
const CLUSTER_PX = 30;
const SAFETY_KEY = 'dbradar-radar-safety-ack';
const CONF_LABEL = { low: '低', mid: '中', high: '高' } as const;
const CONF_ALPHA = { low: 0.45, mid: 0.75, high: 1 } as const;

const RECORD_TEXT: Partial<Record<EventType, string>> = { online: '上線', accept: '接單', pickup: '上客', dropoff: '下客' };

/** 靠近第一名時嗶嗶：每進入更近的一段（500／250／100 公尺）響一次，換目標就重新算 */
function useNearBeep(target: Candidate | null, on: boolean) {
  const last = useRef<{ cell: string | null; band: number }>({ cell: null, band: 0 });
  const latest = useRef({ target, on });
  latest.current = { target, on };
  useEffect(
    () =>
      onFix((f) => {
        const { target: t, on: enabled } = latest.current;
        if (!t || t.here) {
          last.current = { cell: null, band: 0 };
          return;
        }
        const band = nearBand(distanceM(f, t.center));
        if (last.current.cell !== t.cell) last.current = { cell: t.cell, band: 0 };
        if (band > last.current.band && enabled) {
          playNear(band);
          try {
            navigator.vibrate?.(band === 3 ? [60, 60, 60] : 40);
          } catch {
            // 不支援震動就算了
          }
        }
        last.current.band = band;
      }),
    [],
  );
}

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;
const mins = (n: number) => `${Math.max(1, Math.round(n))} 分鐘`;

function readFlag(): boolean {
  try {
    return localStorage.getItem(SAFETY_KEY) === '1';
  } catch {
    return false;
  }
}

/** 目前位置：每 30 秒或移動超過 200 公尺才更新一次，避免雷達一直重算 */
function useCalcPosition(fallback: LatLon): { pos: LatLon; real: boolean; at: number } {
  const [p, setP] = useState(() => {
    const f = lastFix();
    return { pos: f ? { lat: f.lat, lon: f.lon } : fallback, real: !!f, at: Date.now() };
  });
  useEffect(() => {
    const off = onFix((f) => {
      setP((cur) => {
        const moved = distanceM(cur.pos, f) > RECALC_MOVE_M;
        if (cur.real && !moved && Date.now() - cur.at < RECALC_MS) return cur;
        return { pos: { lat: f.lat, lon: f.lon }, real: true, at: Date.now() };
      });
    });
    const t = setInterval(() => setP((cur) => ({ ...cur, at: Date.now() })), RECALC_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return p;
}

export function RadarPage() {
  const app = useAppState();
  const { index, loading } = useAnalytics();
  const heading = useHeading();
  const calc = useCalcPosition(app.settings.homeCenter);
  const [picked, setPicked] = useState<{ c: Candidate; count: number } | null>(null);
  const [safetyAck, setSafetyAck] = useState(readFlag);
  useWakeLock(true);

  const slot = slotOf(calc.at, new Set(app.settings.holidays));
  const rec = useMemo<Recommendation | null>(
    () => (index ? recommend(index, slot, calc.pos, app.settings) : null),
    [index, slot, calc.pos, app.settings],
  );
  const dots = useMemo(() => (rec ? rec.candidates.filter((c) => !c.here).slice(0, MAX_DOTS) : []), [rec]);
  const tripCount = index?.tripCount ?? 0;
  const enough = tripCount >= MIN_TRIPS;
  const target = enough && rec && !rec.stay ? rec.best : null;
  useNearBeep(target, app.settings.radarSound);
  const recordAction = allowedActions(app.status.state).find((a) => a in RECORD_TEXT);

  return (
    <div class="radar-page">
      <TopCard rec={rec} enough={enough} heading={heading.deg} loading={loading || !index} />
      <RadarCanvas
        dots={enough ? dots : []}
        best={enough && rec && !rec.stay ? rec.best : null}
        heading={heading.deg}
        maxKm={app.settings.maxRadarKm}
        sweep={app.settings.radarSweep}
        corner={app.settings.radarCorner}
        sound={app.settings.radarSound}
        onPick={(c, count) => setPicked({ c, count })}
      >
        {app.settings.radarRecordButton && recordAction && (
          <button
            type="button"
            class={`radar-record rec-${recordAction}`}
            onClick={() => {
              try {
                navigator.vibrate?.(40);
              } catch {
                // 不支援震動就算了
              }
              void press(recordAction);
            }}
          >
            {RECORD_TEXT[recordAction]}
          </button>
        )}
      </RadarCanvas>
      <p class="radar-foot">
        {slotLabel(slot)}・資料 {tripCount} 趟
        {rec && enough && `・信心度${CONF_LABEL[rec.best.confidence]}`}
        {heading.source === 'gps' ? '・車頭朝上' : heading.source === 'held' ? '・車頭朝上（停車鎖定）' : heading.source === 'compass' ? '・手機朝上' : '・北方朝上'}
        {!calc.real && '・還沒有定位，先用預設中心'}
      </p>

      {picked && (() => { const pc = picked.c; return (
        <Dialog title={`${compassLabel(pc.bearing)} ${pc.straightKm.toFixed(1)} km${picked.count > 1 ? `（這一區 ${picked.count} 格）` : ''}`} onClose={() => setPicked(null)}>
          <dl class="facts">
            <dt>預期時薪</dt>
            <dd>{money(pc.score)}</dd>
            <dt>預期等待</dt>
            <dd>{mins(pc.W)}</dd>
            <dt>開過去</dt>
            <dd>
              {mins(pc.T)}（約 {pc.distKm.toFixed(1)} km）
            </dd>
            <dt>每單實收</dt>
            <dd>{money(pc.V)}</dd>
            <dt>每單耗時</dt>
            <dd>{mins(pc.D)}</dd>
            <dt>派單率</dt>
            <dd>{pc.offerRate == null ? '—' : `每小時 ${pc.offerRate.toFixed(1)} 單`}</dd>
            <dt>拒單比</dt>
            <dd>{pc.declineRatio == null ? '—' : `${Math.round(pc.declineRatio * 100)}%`}</dd>
            <dt>樣本</dt>
            <dd>
              空車 {pc.idleHours.toFixed(1)} 小時、{pc.orders.toFixed(0)} 單（附近共 {pc.nearbyHours.toFixed(1)} 小時）
            </dd>
            <dt>信心度</dt>
            <dd>{CONF_LABEL[pc.confidence]}</dd>
          </dl>
          <button type="button" class="btn primary" onClick={() => setPicked(null)}>
            好
          </button>
        </Dialog>
      ); })()}

      {!safetyAck && (
        <Dialog title="開車注意" onClose={() => undefined}>
          <p>開車時請把手機放在手機架上，不要手持操作。雷達只在停車或等紅燈時看一眼就好。</p>
          <button
            type="button"
            class="btn primary"
            onClick={() => {
              try {
                localStorage.setItem(SAFETY_KEY, '1');
              } catch {
                // 存不起來就下次再提醒
              }
              setSafetyAck(true);
            }}
          >
            知道了
          </button>
        </Dialog>
      )}
    </div>
  );
}

function TopCard(props: { rec: Recommendation | null; enough: boolean; heading: number | null; loading: boolean }) {
  const { rec, enough } = props;
  if (props.loading) return <section class="radar-card muted">計算中…</section>;
  if (!rec) return <section class="radar-card muted">還沒有資料</section>;
  if (!enough) {
    return (
      <section class="radar-card">
        <div class="radar-main">資料累積中</div>
        <div class="progress">
          <div style={{ width: `${Math.min(100, (rec.tripCount / MIN_TRIPS) * 100)}%` }} />
        </div>
        <div class="radar-sub">
          已記錄 {rec.tripCount} 趟，累積到 {MIN_TRIPS} 趟後開始推薦
        </div>
      </section>
    );
  }
  if (rec.best.here && !hasEnoughData(rec.here)) {
    return (
      <section class="radar-card">
        <div class="radar-main">這附近還沒有資料</div>
        <div class="radar-sub muted">雷達範圍內沒有足夠的記錄，開到常跑的區域再看看</div>
      </section>
    );
  }
  if (rec.stay) {
    return (
      <section class="radar-card">
        <div class="radar-main">原地等候最划算</div>
        <div class="radar-sub">
          預估等 {mins(rec.here.W)}・時薪約 {money(rec.here.score)}
        </div>
      </section>
    );
  }
  const b = rec.best;
  const rot = b.bearing - (props.heading ?? 0);
  return (
    <section class="radar-card">
      <div class="radar-main">
        <span class="arrow" style={{ transform: `rotate(${rot}deg)` }} aria-hidden="true">
          ↑
        </span>
        {compassLabel(b.bearing)} {b.straightKm.toFixed(1)} km
      </div>
      <div class="radar-sub">
        預估等 {mins(b.W)}・時薪約 {money(b.score)}
      </div>
    </section>
  );
}

const COLORS = {
  screen: '#1d6b35',
  screenEdge: '#0f3d1f',
  grid: 'rgba(5, 30, 14, 0.75)',
  ring: 'rgba(200, 255, 210, 0.35)',
  label: 'rgba(225, 255, 230, 0.85)',
  dot: '#ffd23f',
  best: '#fff3a0',
  me: '#ff3b30',
  sweep: 'rgba(160, 255, 180, 0.22)',
};

function RadarCanvas(props: {
  dots: Candidate[];
  best: Candidate | null;
  heading: number | null;
  maxKm: number;
  sweep: boolean;
  corner: 'bl' | 'bc' | 'br';
  sound: boolean;
  onPick: (c: Candidate, count: number) => void;
  children?: ComponentChildren;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const placed = useRef<{ c: Candidate; count: number; x: number; y: number }[]>([]);
  // 範圍：target 是要去的，shown 是畫面上的；每一幀 shown 往 target 靠，看起來是慢慢放大
  const zoom = useRef({ target: props.maxKm, shown: props.maxKm });
  // 使用者自己按過按鈕或雙指縮放後，就不再自動調整範圍
  const userZoomed = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; range: number } | null>(null);
  const [pressed, setPressed] = useState(0);

  // 打開雷達或熱點更新時，自動選一個看得到點的範圍
  useEffect(() => {
    if (userZoomed.current || !props.dots.length) return;
    zoom.current.target = fitRange(
      props.dots.map((d) => d.straightKm),
      props.best?.straightKm ?? null,
      props.maxKm,
    );
  }, [props.dots, props.best, props.maxKm]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let size = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      size = Math.min(canvas.parentElement!.parentElement!.clientWidth, 520);
      canvas.style.width = canvas.style.height = `${size}px`;
      // 按鈕位置用這個尺寸算（CSS 變數）
      canvas.parentElement!.style.setProperty('--s', `${size}px`);
      canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);

    const draw = (now: number) => {
      const p = latest.current;
      const z = zoom.current;
      z.target = clampRange(z.target, p.maxKm);
      // 用對數空間的指數趨近，約 0.6 秒到位
      const dt = Math.min(100, now - last);
      last = now;
      const k = 1 - Math.exp(-dt / 160);
      z.shown = Math.exp(Math.log(z.shown) + (Math.log(z.target) - Math.log(z.shown)) * k);
      if (Math.abs(Math.log(z.shown / z.target)) < 0.002) z.shown = z.target;
      const range = z.shown;

      const c = size / 2;
      const R = c - 6;
      const pxPerKm = R / range;
      const rot = ((p.heading ?? 0) * Math.PI) / 180;
      ctx.clearRect(0, 0, size, size);

      // 螢幕
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.screen;
      ctx.fill();
      ctx.clip();

      // 方格：格子大小跟著範圍換成好讀的距離，跟著車頭方向轉
      const gridKm = niceStep(range / 5);
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(-rot);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1.5;
      const span = Math.ceil((range * 1.5) / gridKm);
      for (let i = -span; i <= span; i++) {
        ctx.beginPath();
        ctx.moveTo(i * gridKm * pxPerKm, -R * 1.5);
        ctx.lineTo(i * gridKm * pxPerKm, R * 1.5);
        ctx.moveTo(-R * 1.5, i * gridKm * pxPerKm);
        ctx.lineTo(R * 1.5, i * gridKm * pxPerKm);
        ctx.stroke();
      }
      ctx.restore();

      // 距離圈：大約三圈，距離取好讀的數字
      const ringKm = niceStep(range / 3);
      ctx.strokeStyle = COLORS.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.fillStyle = COLORS.label;
      ctx.font = '13px system-ui, sans-serif';
      for (let km = ringKm; km <= range + 1e-9; km += ringKm) {
        ctx.beginPath();
        ctx.arc(c, c, km * pxPerKm, 0, Math.PI * 2);
        ctx.stroke();
        // 標在右側水平線上，不會和上方的 N 疊在一起
        const label = km < 1 ? `${Math.round(km * 1000)} m` : `${+km.toFixed(2)} km`;
        ctx.fillText(label, c + km * pxPerKm - ctx.measureText(label).width - 4, c - 5);
      }
      ctx.setLineDash([]);

      // 掃描線（裝飾）
      if (p.sweep) {
        const a = ((now % 3000) / 3000) * Math.PI * 2 - Math.PI / 2;
        const g = ctx.createConicGradient?.(a - Math.PI / 3, c, c);
        if (g) {
          g.addColorStop(0, 'rgba(160,255,180,0)');
          g.addColorStop(1 / 6, COLORS.sweep);
          g.addColorStop(1 / 6 + 0.001, 'rgba(160,255,180,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.arc(c, c, R, a - Math.PI / 3, a);
          ctx.fill();
        }
      }

      // 熱點：範圍外的不畫（最佳那一格例外，貼在邊緣指出方向），附近的合成一個點
      const pts: Placed<Candidate>[] = [];
      for (const d of p.dots) {
        const isBest = p.best?.cell === d.cell;
        if (d.straightKm > range && !isBest) continue;
        const r = Math.min(R - 12, d.straightKm * pxPerKm);
        const ang = ((d.bearing - (p.heading ?? 0)) * Math.PI) / 180;
        pts.push({ item: d, x: c + r * Math.sin(ang), y: c - r * Math.cos(ang), score: d.score });
      }
      const clusters = clusterDots(pts, CLUSTER_PX);
      const scores = clusters.map((d) => d.score);
      const hi = Math.max(...scores, 1);
      const lo = Math.min(...scores, 0);
      placed.current = [];
      for (const cl of clusters) {
        const d = cl.best;
        placed.current.push({ c: d, count: cl.count, x: cl.x, y: cl.y });
        const t = hi > lo ? (cl.score - lo) / (hi - lo) : 1;
        const isBest = p.best?.cell === d.cell;
        const blink = isBest ? 0.55 + 0.45 * Math.abs(Math.sin(now / 350)) : 1;
        const rad = clusterRadius(cl.count);
        ctx.globalAlpha = Math.max(0.35, CONF_ALPHA[d.confidence] * (0.55 + 0.45 * t)) * blink;
        ctx.beginPath();
        ctx.arc(cl.x, cl.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = isBest ? COLORS.best : COLORS.dot;
        ctx.fill();
        if (isBest) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = COLORS.dot;
          ctx.beginPath();
          ctx.arc(cl.x, cl.y, rad + 6, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // 外框（不跟著縮放）
      ctx.lineWidth = 6;
      ctx.strokeStyle = COLORS.screenEdge;
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.stroke();

      // 北方標示
      const nA = -rot;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', c + (R - 16) * Math.sin(nA), c - (R - 16) * Math.cos(nA));
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';

      // 自己：紅色三角形，尖端朝前進方向（車頭朝上時永遠朝上）
      ctx.save();
      ctx.translate(c, c);
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(11, 10);
      ctx.lineTo(-11, 10);
      ctx.closePath();
      ctx.fillStyle = COLORS.me;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
    };
  }, []);

  const onClick = (e: MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: { c: Candidate; count: number; d: number } | null = null;
    for (const p of placed.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 32 && (!best || d < best.d)) best = { c: p.c, count: p.count, d };
    }
    if (best) props.onPick(best.c, best.count);
  };

  // 雙指縮放：只改圓裡的範圍，外框和頁面不動（canvas 設了 touch-action: none）
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onPointerDown = (e: PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      pinch.current = { dist: spread(), range: zoom.current.target };
      userZoomed.current = true;
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pc = pinch.current;
    const d = spread();
    if (pc && d > 0) {
      const km = clampRange((pc.range * pc.dist) / d, latest.current.maxKm);
      zoom.current.target = zoom.current.shown = km;
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onZoomButton = () => {
    const z = zoom.current;
    z.target = nextZoom(z.target, props.maxKm);
    userZoomed.current = true;
    if (props.sound) playZoom(zoomStage(z.target, props.maxKm));
    try {
      navigator.vibrate?.(20);
    } catch {
      // 不支援震動就算了
    }
    setPressed((n) => n + 1);
  };

  return (
    <div class="radar-wrap">
      <div class={`radar-box zoom-${props.corner}`}>
        <canvas
          ref={ref}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="熱點雷達"
        />
        <button
          key={pressed}
          type="button"
          class={`radar-zoom corner-${props.corner}${pressed ? ' pressed' : ''}`}
          onClick={onZoomButton}
          aria-label="切換雷達範圍"
        >
          <span class="cap" />
        </button>
        {props.children}
      </div>
    </div>
  );
}
