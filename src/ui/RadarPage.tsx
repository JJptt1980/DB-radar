// 雷達頁（SPEC 5.2）：圓形螢幕、方格底、黃色光點是熱點、中間紅色三角形是自己。全部自己用 Canvas 畫。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hasEnoughData, recommend, type Candidate, type Recommendation, MIN_TRIPS } from '../analytics/model';
import { slotLabel, slotOf } from '../analytics/slots';
import { compassLabel, distanceM, type LatLon } from '../domain/geo';
import { lastFix, onFix } from '../sensors/gps';
import { useHeading } from '../sensors/heading';
import { useWakeLock } from '../sensors/wakeLock';
import { Dialog } from './Dialog';
import { useAppState } from './store';
import { useAnalytics } from './useAnalytics';

const RECALC_MS = 30_000;
const RECALC_MOVE_M = 200;
const MAX_DOTS = 8;
const SAFETY_KEY = 'dbradar-radar-safety-ack';
const CONF_LABEL = { low: '低', mid: '中', high: '高' } as const;
const CONF_ALPHA = { low: 0.45, mid: 0.75, high: 1 } as const;

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
  const [picked, setPicked] = useState<Candidate | null>(null);
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

  return (
    <div class="radar-page">
      <TopCard rec={rec} enough={enough} heading={heading.deg} loading={loading || !index} />
      <RadarCanvas
        dots={enough ? dots : []}
        best={enough && rec && !rec.stay ? rec.best : null}
        heading={heading.deg}
        maxKm={app.settings.maxRadarKm}
        rings={app.settings.radarRingsKm}
        sweep={app.settings.radarSweep}
        onPick={setPicked}
      />
      <p class="radar-foot">
        {slotLabel(slot)}・資料 {tripCount} 趟
        {rec && enough && `・信心度${CONF_LABEL[rec.best.confidence]}`}
        {heading.source === 'gps' ? '・車頭朝上' : heading.source === 'held' ? '・車頭朝上（停車鎖定）' : heading.source === 'compass' ? '・手機朝上' : '・北方朝上'}
        {!calc.real && '・還沒有定位，先用預設中心'}
      </p>

      {picked && (
        <Dialog title={`${compassLabel(picked.bearing)} ${picked.straightKm.toFixed(1)} km`} onClose={() => setPicked(null)}>
          <dl class="facts">
            <dt>預期時薪</dt>
            <dd>{money(picked.score)}</dd>
            <dt>預期等待</dt>
            <dd>{mins(picked.W)}</dd>
            <dt>開過去</dt>
            <dd>
              {mins(picked.T)}（約 {picked.distKm.toFixed(1)} km）
            </dd>
            <dt>每單實收</dt>
            <dd>{money(picked.V)}</dd>
            <dt>每單耗時</dt>
            <dd>{mins(picked.D)}</dd>
            <dt>派單率</dt>
            <dd>{picked.offerRate == null ? '—' : `每小時 ${picked.offerRate.toFixed(1)} 單`}</dd>
            <dt>拒單比</dt>
            <dd>{picked.declineRatio == null ? '—' : `${Math.round(picked.declineRatio * 100)}%`}</dd>
            <dt>樣本</dt>
            <dd>
              空車 {picked.idleHours.toFixed(1)} 小時、{picked.orders.toFixed(0)} 單（附近共 {picked.nearbyHours.toFixed(1)} 小時）
            </dd>
            <dt>信心度</dt>
            <dd>{CONF_LABEL[picked.confidence]}</dd>
          </dl>
          <button type="button" class="btn primary" onClick={() => setPicked(null)}>
            好
          </button>
        </Dialog>
      )}

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
  rings: number[];
  sweep: boolean;
  onPick: (c: Candidate) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const placed = useRef<{ c: Candidate; x: number; y: number }[]>([]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let size = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      size = Math.min(canvas.parentElement!.clientWidth, 520);
      canvas.style.width = canvas.style.height = `${size}px`;
      canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);

    const draw = (now: number) => {
      const p = latest.current;
      const c = size / 2;
      const R = c - 6;
      const pxPerKm = R / p.maxKm;
      const rot = ((p.heading ?? 0) * Math.PI) / 180;
      ctx.clearRect(0, 0, size, size);

      // 螢幕
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.screen;
      ctx.fill();
      ctx.clip();

      // 方格：每格 1 公里，跟著車頭方向轉
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(-rot);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1.5;
      const span = Math.ceil(p.maxKm * 1.5);
      for (let k = -span; k <= span; k++) {
        ctx.beginPath();
        ctx.moveTo(k * pxPerKm, -R * 1.5);
        ctx.lineTo(k * pxPerKm, R * 1.5);
        ctx.moveTo(-R * 1.5, k * pxPerKm);
        ctx.lineTo(R * 1.5, k * pxPerKm);
        ctx.stroke();
      }
      ctx.restore();

      // 距離圈
      ctx.strokeStyle = COLORS.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.fillStyle = COLORS.label;
      ctx.font = '13px system-ui, sans-serif';
      for (const km of p.rings) {
        if (km > p.maxKm) continue;
        ctx.beginPath();
        ctx.arc(c, c, km * pxPerKm, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${km} km`, c + 4, c - km * pxPerKm + 14);
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

      // 熱點
      const scores = p.dots.map((d) => d.score);
      const hi = Math.max(...scores, 1);
      const lo = Math.min(...scores, 0);
      placed.current = [];
      p.dots.forEach((d) => {
        const r = Math.min(R - 10, d.straightKm * pxPerKm);
        const ang = ((d.bearing - (p.heading ?? 0)) * Math.PI) / 180;
        const x = c + r * Math.sin(ang);
        const y = c - r * Math.cos(ang);
        placed.current.push({ c: d, x, y });
        const t = hi > lo ? (d.score - lo) / (hi - lo) : 1;
        const isBest = p.best?.cell === d.cell;
        const blink = isBest ? 0.55 + 0.45 * Math.abs(Math.sin(now / 350)) : 1;
        ctx.globalAlpha = CONF_ALPHA[d.confidence] * blink;
        ctx.beginPath();
        ctx.arc(x, y, 5 + 5 * t, 0, Math.PI * 2);
        ctx.fillStyle = isBest ? COLORS.best : COLORS.dot;
        ctx.fill();
        if (isBest) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = COLORS.dot;
          ctx.beginPath();
          ctx.arc(x, y, 11 + 5 * t, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
      ctx.restore();

      // 外框
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
    let best: { c: Candidate; d: number } | null = null;
    for (const p of placed.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 32 && (!best || d < best.d)) best = { c: p.c, d };
    }
    if (best) props.onPick(best.c);
  };

  return (
    <div class="radar-wrap">
      <canvas ref={ref} onClick={onClick} aria-label="熱點雷達" />
    </div>
  );
}
