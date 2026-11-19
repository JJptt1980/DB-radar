// 雷達頁（SPEC 5.2）：圓形螢幕、方格底、黃色光點是熱點、中間紅色三角形是自己。全部自己用 Canvas 畫。
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hasEnoughData, recommend, type Candidate, type Recommendation, MIN_TRIPS } from '../analytics/model';
import { DAY_TYPES, slotLabel, slotOf, type Slot } from '../analytics/slots';
import { mergedView } from '../analytics/heat';
import { compassLabel, distanceM, type LatLon } from '../domain/geo';
import { lastFix, onFix } from '../sensors/gps';
import { useHeading } from '../sensors/heading';
import { useWakeLock } from '../sensors/wakeLock';
import { Dialog } from './Dialog';
import { clampRange, clusterDots, clusterRadius, fitRange, nearBeep, nextZoom, niceStep, radarMaxKm, zoomStage, type Placed } from './radarZoom';
import { playNear, playZoom } from './radarSound';
import { memeAt } from './memes';
import { useTilt } from './useTilt';
import type { DriverState } from '../domain/state';
import { allowedActions } from '../domain/state';
import type { EventType } from '../db/types';
import { getState, loadAll, press } from './store';
import { saveSettings } from '../db/db';
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

/** 靠近龍珠（雷達上任何一個熱點）時嗶嗶：進入 500／250／100 公尺各響一次，越近嗶越多越快 */
function useNearBeep(dots: readonly Candidate[], on: boolean, onBeep: (band: number) => void) {
  const memory = useRef(new Map<string, number>());
  const latest = useRef({ dots, on, onBeep });
  latest.current = { dots, on, onBeep };
  useEffect(
    () =>
      onFix((f) => {
        const { dots: ds, on: enabled } = latest.current;
        const band = nearBeep(
          memory.current,
          ds.map((d) => ({ cell: d.cell, distM: distanceM(f, d.center) })),
        );
        if (band && enabled) {
          playNear(band);
          latest.current.onBeep(band);
          try {
            navigator.vibrate?.(band === 3 ? [60, 60, 60] : 40);
          } catch {
            // 不支援震動就算了
          }
        }
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
  // 這個時段全城都沒有任何有資料的格子時，往前後的時段找（12 點沒有就看 11～13 點，再沒有看 10～14 點…），
  // 同一種日子（平日／週五…）找不到再放寬到所有日子，雷達才不會一片空白，也不會變成不分時段的大平均
  const { rec, widened } = useMemo<{ rec: Recommendation | null; widened: string | null }>(() => {
    if (!index) return { rec: null, widened: null };
    const has = (r: Recommendation) => r.candidates.some((c) => !c.here) || r.far.length > 0 || hasEnoughData(r.here);
    const r = recommend(index, slot, calc.pos, app.settings);
    if (has(r)) return { rec: r, widened: null };
    const [day, hourStr] = slot.split(':') as [string, string];
    const hour = Number(hourStr);
    for (const days of [[day], DAY_TYPES as readonly string[]]) {
      for (let k = 1; k <= 12; k++) {
        const hours = Array.from({ length: 2 * k + 1 }, (_, i) => (hour - k + i + 24) % 24);
        const view = mergedView(index, days.flatMap((d) => hours.map((h) => `${d}:${h}` as Slot)), app.settings.importWeight);
        const w = recommend(index, slot, calc.pos, app.settings, view);
        if (has(w)) {
          const range = `${(hour - k + 24) % 24}～${(hour + k) % 24} 點`;
          return { rec: w, widened: days.length > 1 ? `各種日子 ${range}` : range };
        }
      }
    }
    return { rec: r, widened: null };
  }, [index, slot, calc.pos, app.settings]);
  // 附近沒有熱點時，改畫範圍外最近的那些，雷達也放大到看得到它們
  const near = useMemo(() => (rec ? rec.candidates.filter((c) => !c.here).slice(0, MAX_DOTS) : []), [rec]);
  const farOnly = !!rec && near.length === 0 && rec.far.length > 0;
  const dots = farOnly ? rec!.far.slice(0, MAX_DOTS) : near;
  const radarMax = rec ? radarMaxKm(app.settings.maxRadarKm, near.length, rec.far.map((c) => c.straightKm)) : app.settings.maxRadarKm;
  const tripCount = index?.tripCount ?? 0;
  const enough = tripCount >= MIN_TRIPS;
  // 雷達上畫出來的所有熱點（含所在這一格，只要有資料）都算龍珠
  const beepDots = useMemo(() => (enough && rec ? rec.candidates.filter((c) => hasEnoughData(c)) : []), [enough, rec]);
  // 載客中不出聲（乘客在車上）；前往接客時目標是乘客不是龍珠，也不嗶
  // 載客中預設靜音；點喇叭可以只為「這一趟」打開，下一趟又回到靜音
  const ontrip = app.status.state === 'ontrip';
  const tripId = ontrip ? lastPickupId(app.events) : null;
  const [tripSoundFor, setTripSoundFor] = useState<string | null>(() => tripSoundOn);
  const tripSound = ontrip && tripId != null && tripSoundFor === tripId;
  const soundLive = ontrip ? tripSound : app.settings.radarSound;
  // 嗶的時候讓右上角的喇叭跟著閃（換 key 讓動畫重播）
  const [beep, setBeep] = useState<{ band: number; at: number } | null>(null);
  useNearBeep(beepDots, soundLive && (app.status.state === 'idle' || ontrip), (band) => setBeep({ band, at: Date.now() }));
  const recordAction = allowedActions(app.status.state).find((a) => a in RECORD_TEXT);

  return (
    <div class="radar-page with-zoom">
      <TopCard
        rec={rec}
        enough={enough}
        heading={heading.deg}
        loading={loading || !index}
        state={app.status.state}
        memeSec={app.settings.memeEnabled ? app.settings.memeIntervalSec : 0}
      />
      {/* 時段、資料量等小字放在卡片下方，雷達下面整塊留給縮放鈕，雷達才能滿版 */}
      <p class="radar-foot">
        {widened ? `${slotLabel(slot)}沒資料・改看 ${widened}` : slotLabel(slot)}・資料 {tripCount} 趟
        {rec && enough && `・信心度${CONF_LABEL[rec.best.confidence]}`}
        {heading.source === 'gps' ? '・車頭朝上' : heading.source === 'held' ? '・車頭朝上（停車鎖定）' : heading.source === 'compass' ? '・手機朝上' : '・北方朝上'}
        {!calc.real && '・還沒有定位，先用預設中心'}
      </p>
      <RadarCanvas
        dots={enough ? dots : []}
        best={enough && rec ? (farOnly ? rec.far[0]! : !rec.stay ? rec.best : null) : null}
        heading={heading.deg}
        maxKm={radarMax}
        sweep={app.settings.radarSweep}
        corner={app.settings.radarCorner}
        sound={soundLive}
        tilt={app.settings.radarTilt}
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
        {/* 靠近龍珠的嗶嗶聲現在會不會響：喇叭＋聲波＝會響；喇叭打叉＝不響（關掉或載客中）。點一下切換開關 */}
        <SoundBadge
          key={beep?.at ?? 0}
          beepBand={beep && Date.now() - beep.at < 1500 ? beep.band : 0}
          on={soundLive}
          muted={false}
          ontrip={ontrip}
          onToggle={() => {
            if (ontrip) {
              const next = tripSound ? null : tripId;
              tripSoundOn = next;
              setTripSoundFor(next);
            } else {
              void saveSettings({ ...getState().settings, radarSound: !getState().settings.radarSound }).then(loadAll);
            }
          }}
        />
      </RadarCanvas>

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

/** 這一趟（上客事件 id）手動打開了音效；換頁回來還記得，下一趟自動失效 */
let tripSoundOn: string | null = null;

function lastPickupId(events: readonly { id: string; type: string; ts: number; deleted?: boolean }[]): string | null {
  let best: { id: string; ts: number } | null = null;
  for (const e of events) if (!e.deleted && e.type === 'pickup' && (!best || e.ts > best.ts)) best = e;
  return best?.id ?? null;
}

function SoundBadge(props: { on: boolean; muted: boolean; ontrip: boolean; beepBand: number; onToggle: () => void }) {
  const live = props.on && !props.muted;
  const label = props.ontrip
    ? live
      ? '載客中：這一趟音效已打開（點一下關掉）'
      : '載客中：靜音（點一下只為這一趟打開）'
    : live
      ? '靠近龍珠的嗶嗶聲：開'
      : '靠近龍珠的嗶嗶聲：關';
  return (
    <button
      type="button"
      class={`radar-sound${live ? ' on' : ''}${live && props.beepBand ? ` beep-${props.beepBand}` : ''}`}
      onClick={props.onToggle}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
        {live ? (
          <>
            <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
            <path d="M19.5 7a7 7 0 0 1 0 10" />
            <path d="M23 4.5a10.5 10.5 0 0 1 0 15" />
          </>
        ) : (
          <path d="M17 8.5l7 7M24 8.5l-7 7" />
        )}
      </svg>
    </button>
  );
}

function useTick(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * 資訊卡：空車、下線時顯示推薦，上面一行小字是龍珠梗；
 * 前往接客、載客中推薦已經沒有意義，整張卡只放梗。
 */
function TopCard(props: {
  rec: Recommendation | null;
  enough: boolean;
  heading: number | null;
  loading: boolean;
  state: DriverState;
  memeSec: number;
}) {
  const now = useTick(1000);
  const meme = props.memeSec > 0 ? memeAt(props.state, now, props.memeSec) : null;
  if (props.state === 'enroute' || props.state === 'ontrip') {
    return (
      <section class="radar-card meme-only">
        <div class="meme-big" key={meme}>
          {meme ?? (props.state === 'ontrip' ? '載客中，安心開' : '前往接客中')}
        </div>
      </section>
    );
  }
  return (
    <div class="card-stack">
      {meme && (
        <div class="meme-line" key={meme}>
          {meme}
        </div>
      )}
      <InfoCard {...props} />
    </div>
  );
}

function InfoCard(props: { rec: Recommendation | null; enough: boolean; heading: number | null; loading: boolean }) {
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
    const f = rec.far[0];
    if (f) {
      // 附近沒資料：指出最近的熱點
      const rot = f.bearing - (props.heading ?? 0);
      return (
        <section class="radar-card">
          <div class="radar-main">
            <span class="arrow" style={{ transform: `rotate(${rot}deg)` }} aria-hidden="true">
              ↑
            </span>
            {compassLabel(f.bearing)} {f.straightKm.toFixed(1)} km
          </div>
          <div class="radar-sub">附近沒有資料，最近的熱點在這個方向</div>
        </section>
      );
    }
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
  // 深綠螢幕（使用者偏好最早的深色），玻璃反光與內陰影照樣保留
  screen: '#1d6b35',
  screenEdge: '#0f3d1f',
  grid: 'rgba(5, 30, 14, 0.75)',
  ring: 'rgba(200, 255, 210, 0.4)',
  label: 'rgba(225, 255, 230, 0.9)',
  dot: '#ffd23f',
  best: '#fff3a0',
  me: '#ff3b30',
  sweep: 'rgba(160, 255, 180, 0.22)',
};

/** 白色外殼：上方受光較亮、下方較暗，加一道高光和落在桌面上的陰影 */
function drawBezel(ctx: CanvasRenderingContext2D, c: number, Ro: number, R: number) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  const body = ctx.createLinearGradient(0, c - Ro, 0, c + Ro);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.55, '#eef0f2');
  body.addColorStop(1, '#c9cdd1');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, Ro, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 外殼頂面的弧形高光
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, Ro, 0, Math.PI * 2);
  ctx.arc(c, c, R + 3, 0, Math.PI * 2, true);
  ctx.clip();
  const shine = ctx.createRadialGradient(c - Ro * 0.45, c - Ro * 0.55, 0, c - Ro * 0.45, c - Ro * 0.55, Ro * 1.1);
  shine.addColorStop(0, 'rgba(255,255,255,0.95)');
  shine.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(c - Ro, c - Ro, Ro * 2, Ro * 2);
  ctx.restore();

  // 外殼外緣細線
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.beginPath();
  ctx.arc(c, c, Ro - 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // 螢幕周圍的深色內緣（往下凹）
  const rim = ctx.createLinearGradient(0, c - R, 0, c + R);
  rim.addColorStop(0, '#5d6469');
  rim.addColorStop(1, '#a7adb2');
  ctx.lineWidth = 3;
  ctx.strokeStyle = rim;
  ctx.beginPath();
  ctx.arc(c, c, R + 1.5, 0, Math.PI * 2);
  ctx.stroke();
}

/** 玻璃：左上一片淡淡的反光，邊緣一圈內陰影 */
function drawGlass(ctx: CanvasRenderingContext2D, c: number, R: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.clip();
  const edge = ctx.createRadialGradient(c, c, R * 0.82, c, c, R);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,20,8,0.45)');
  ctx.fillStyle = edge;
  ctx.fillRect(c - R, c - R, R * 2, R * 2);
  const glare = ctx.createLinearGradient(c - R, c - R, c, c);
  glare.addColorStop(0, 'rgba(255,255,255,0.16)');
  glare.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glare;
  ctx.beginPath();
  ctx.ellipse(c - R * 0.25, c - R * 0.35, R * 0.75, R * 0.45, -Math.PI / 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function RadarCanvas(props: {
  dots: Candidate[];
  best: Candidate | null;
  heading: number | null;
  maxKm: number;
  sweep: boolean;
  corner: 'bl' | 'bc' | 'br';
  sound: boolean;
  tilt: boolean;
  onPick: (c: Candidate, count: number) => void;
  children?: ComponentChildren;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useTilt(boxRef, props.tilt);
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
      // 雷達頁是固定一個螢幕高的版面，雷達區（radar-wrap）分到多少空間就畫多大
      const wrap = canvas.parentElement!.parentElement!;
      size = Math.max(200, Math.min(wrap.clientWidth, wrap.clientHeight, 560));
      canvas.style.width = canvas.style.height = `${size}px`;
      // 按鈕位置用這個尺寸算（CSS 變數）
      canvas.parentElement!.style.setProperty('--s', `${size}px`);
      canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);
    // 上方卡片內容變了（高度改變）時重新量
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas.parentElement!.parentElement!);

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
      // 俯瞰的裝置：最外圈白色外殼，裡面一圈深色內緣，再裡面是綠色螢幕
      // 外殼做薄（約為螢幕直徑的 3.5%），雷達面積盡量大
      const Ro = c - 1; // 外殼頂到畫布邊緣（畫布與螢幕同寬）
      const bezel = Math.max(8, size * 0.035);
      const R = Ro - bezel;
      const pxPerKm = R / range;
      const rot = ((p.heading ?? 0) * Math.PI) / 180;
      ctx.clearRect(0, 0, size, size);
      drawBezel(ctx, c, Ro, R);

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

      // 螢幕玻璃的反光與內緣陰影（不跟著縮放）
      drawGlass(ctx, c, R);

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
      ro.disconnect();
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
      <div class="radar-box" ref={boxRef}>
        <canvas
          ref={ref}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="熱點雷達"
        />
        {props.children}
      </div>
      {/* 縮放鈕固定在畫面最下方，從分頁列後面冒出來 */}
      <button
        key={pressed}
        type="button"
        class={`radar-zoom zoom-${props.corner}${pressed ? ' pressed' : ''}`}
        onClick={onZoomButton}
        aria-label="切換雷達範圍"
      >
        <span class="body" />
        <span class="cap" />
      </button>
    </div>
  );
}
