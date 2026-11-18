// 地圖熱力圖的資料（SPEC 5.3 Phase 4）：每個 H3 六角形的預期時薪，可依日型與時段切換。純函式。
import { cellToBoundary } from 'h3-js';
import type { Settings } from '../db/types';
import { estimate, hasEnoughData, viewAt, type Confidence, type SlotView } from './model';
import { DAY_TYPES, type DayType, type Slot } from './slots';
import { emptyAcc, emptyVideo, type Acc, type StatsIndex, type VideoAcc } from './stats';

export type DayChoice = DayType | 'all';
export type HourChoice = number | 'all';

export interface HexCell {
  cell: string;
  /** [lat, lon] 頂點 */
  boundary: [number, number][];
  hourly: number;
  waitMin: number;
  perOrder: number;
  orders: number;
  idleHours: number;
  confidence: Confidence;
}

function addAcc(t: Acc, s: Acc) {
  for (const k of Object.keys(t) as (keyof Acc)[]) t[k] += s[k];
}
function addVid(t: VideoAcc, s: VideoAcc) {
  for (const k of Object.keys(t) as (keyof VideoAcc)[]) t[k] += s[k];
}

/** 把多個槽位的原始累計量直接加總（「整天」或「全部日型」用） */
export function mergedView(index: StatsIndex, slots: readonly Slot[]): SlotView {
  const cells = new Map<string, Acc>();
  const video = new Map<string, VideoAcc>();
  for (const s of slots) {
    for (const [c, a] of index.cells.get(s) ?? []) {
      let t = cells.get(c);
      if (!t) cells.set(c, (t = emptyAcc()));
      addAcc(t, a);
    }
    for (const [c, a] of index.video.get(s) ?? []) {
      let t = video.get(c);
      if (!t) video.set(c, (t = emptyVideo()));
      addVid(t, a);
    }
  }
  const city = emptyAcc();
  for (const a of cells.values()) addAcc(city, a);
  const cityAll = emptyAcc();
  for (const m of index.cells.values()) for (const a of m.values()) addAcc(cityAll, a);
  return { slot: slots[0] ?? 'weekday:0', cells, video, city, cityAll };
}

export function viewFor(index: StatsIndex, day: DayChoice, hour: HourChoice): SlotView {
  if (day !== 'all' && hour !== 'all') return viewAt(index, `${day}:${hour}`);
  const days = day === 'all' ? DAY_TYPES : [day];
  const hours = hour === 'all' ? Array.from({ length: 24 }, (_, i) => i) : [hour];
  return mergedView(index, days.flatMap((d) => hours.map((h) => `${d}:${h}` as Slot)));
}

/** 不含開車過去的預期時薪（地圖不是從某個位置出發） */
export function heatCells(index: StatsIndex, day: DayChoice, hour: HourChoice, settings: Settings): HexCell[] {
  const view = viewFor(index, day, hour);
  const out: HexCell[] = [];
  for (const cell of view.cells.keys()) {
    const e = estimate(view, cell, settings);
    if (!hasEnoughData(e)) continue;
    out.push({
      cell,
      boundary: cellToBoundary(cell) as [number, number][],
      hourly: (e.V / (e.W + e.D)) * 60,
      waitMin: e.W,
      perOrder: e.V,
      orders: e.orders,
      idleHours: e.idleHours,
      confidence: e.confidence,
    });
  }
  return out.sort((a, b) => b.hourly - a.hourly);
}

/** 由冷到熱的色階：深青 → 綠 → 黃 → 橘 → 紅（深色底上分得清楚） */
const STOPS: [number, number, number][] = [
  [30, 90, 110],
  [40, 170, 90],
  [230, 220, 60],
  [245, 150, 40],
  [235, 60, 50],
];

export function heatColor(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [STOPS[i]!, STOPS[i + 1]!];
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** 用第 10～90 百分位當色階兩端，避免一兩格極端值把其他格子都壓成同一色 */
export function scaleRange(values: readonly number[]): [number, number] {
  if (!values.length) return [0, 1];
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;
  const lo = q(0.1);
  const hi = q(0.9);
  return hi > lo ? [lo, hi] : [v[0]!, v[v.length - 1]! > v[0]! ? v[v.length - 1]! : v[0]! + 1];
}
