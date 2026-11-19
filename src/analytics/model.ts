// 平滑、時段混合、推薦分數（SPEC 4.3～4.5）。純函式。
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import type { Settings } from '../db/types';
import { bearingDeg, distanceM, type LatLon } from '../domain/geo';
import { adjacentSlots, type Slot } from './slots';
import { emptyAcc, emptyVideo, type Acc, type CellMap, type StatsIndex, type VideoAcc } from './stats';

/** 收縮用的虛擬樣本：接單率 2 小時、每單實收與耗時 3 單 */
export const M_HOURS = 2;
export const M_ORDERS = 3;
/** 時段混合權重：本小時、前一小時、下一小時 */
const BLEND: [number, number, number] = [0.6, 0.2, 0.2];
/** 完全沒有資料時的預設值，只在冷啟動時用到 */
const DEFAULT_LAMBDA = 1;
const DEFAULT_V = 200;
const DEFAULT_D = 25;
const MAX_WAIT_MIN = 240;
export const MIN_TRIPS = 30;

function addInto(t: Acc, s: Acc, w: number) {
  t.idleHours += s.idleHours * w;
  t.orders += s.orders * w;
  t.declined += s.declined * w;
  t.sumNetFare += s.sumNetFare * w;
  t.fareOrders += s.fareOrders * w;
  t.sumOrderMinutes += s.sumOrderMinutes * w;
  t.durOrders += s.durOrders * w;
}
function addVideo(t: VideoAcc, s: VideoAcc, w: number) {
  t.idleHours += s.idleHours * w;
  t.orders += s.orders * w;
  t.sumFare += s.sumFare * w;
  t.fareOrders += s.fareOrders * w;
}

function blendMaps<T>(maps: (CellMap<T> | undefined)[], make: () => T, add: (t: T, s: T, w: number) => void): CellMap<T> {
  const out: CellMap<T> = new Map();
  maps.forEach((m, i) => {
    if (!m) return;
    for (const [cell, a] of m) {
      let t = out.get(cell);
      if (!t) out.set(cell, (t = make()));
      add(t, a, BLEND[i]!);
    }
  });
  return out;
}

export interface SlotView {
  slot: Slot;
  cells: CellMap<Acc>;
  video: CellMap<VideoAcc>;
  city: Acc;
  cityAll: Acc;
}

const sumAcc = (m: Iterable<Acc>): Acc => {
  const t = emptyAcc();
  for (const a of m) addInto(t, a, 1);
  return t;
};

/**
 * 0.6 × 本小時 + 0.2 × 前一小時 + 0.2 × 下一小時（同日型），在原始累計量上混合。
 * 全城層 = 有地點的資料加總 ＋ importWeight × 官方資料裡沒有地點的部分。
 */
export function viewAt(index: StatsIndex, slot: Slot, importWeight = 0.3): SlotView {
  const [prev, next] = adjacentSlots(slot);
  const order = [slot, prev, next];
  const cells = blendMaps(order.map((s) => index.cells.get(s)), emptyAcc, addInto);
  const video = blendMaps(order.map((s) => index.video.get(s)), emptyVideo, addVideo);
  const city = sumAcc(cells.values());
  order.forEach((s, i) => {
    const o = index.official?.get(s);
    if (o) addInto(city, o, BLEND[i]! * importWeight);
  });
  const all: Acc[] = [];
  for (const m of index.cells.values()) all.push(...m.values());
  const cityAll = sumAcc(all);
  for (const o of index.official?.values() ?? []) addInto(cityAll, o, importWeight);
  return { slot, cells, video, city, cityAll };
}

export type Confidence = 'low' | 'mid' | 'high';

export interface CellEstimate {
  cell: string;
  /** 平滑後的接單率（單/小時） */
  lambda: number;
  /** 每單實收 */
  V: number;
  /** 每單耗時（分） */
  D: number;
  /** 預期等待（分） */
  W: number;
  /** 派單率（單/小時，含拒單） */
  offerRate: number | null;
  declineRatio: number | null;
  /** 這一格自己的空車時數與單數（混合後） */
  idleHours: number;
  orders: number;
  /** 這格加上一圈鄰居的空車時數與單數 */
  nearbyHours: number;
  nearbyOrders: number;
  shrink: number;
  confidence: Confidence;
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

/** 一個格子的平滑估計（4.3、4.6） */
export function estimate(view: SlotView, cell: string, settings: Settings): CellEstimate {
  const own = view.cells.get(cell) ?? emptyAcc();
  const ring = emptyAcc();
  for (const n of gridDisk(cell, 1)) {
    if (n === cell) continue;
    const a = view.cells.get(n);
    if (a) addInto(ring, a, 1);
  }
  const w = settings.importWeight;
  const vid = view.video.get(cell) ?? emptyVideo();

  // 先驗逐層收縮：預設值 → 全部資料的全城 → 同槽位全城 → 一圈鄰居。
  // 每一層都往上一層收縮，資料少的層影響小，不會因為鄰居差一點點不夠就整個跳到全城平均。
  const layered = (num: (a: Acc) => number, den: (a: Acc) => number, m: number, fallback: number) => {
    let prior = fallback;
    for (const a of [view.cityAll, view.city, ring]) prior = (num(a) + m * prior) / (den(a) + m);
    return prior;
  };
  let lambdaPrior = layered((a) => a.orders, (a) => a.idleHours, M_HOURS, DEFAULT_LAMBDA);
  // 影片空檔是鄰居先驗之前的一層先驗，權重 importWeight
  lambdaPrior = (w * vid.orders + M_HOURS * lambdaPrior) / (w * vid.idleHours + M_HOURS);
  let vPrior = layered((a) => a.sumNetFare, (a) => a.fareOrders, M_ORDERS, DEFAULT_V);
  vPrior = (w * vid.sumFare + M_ORDERS * vPrior) / (w * vid.fareOrders + M_ORDERS);
  const dPrior = layered((a) => a.sumOrderMinutes, (a) => a.durOrders, M_ORDERS, DEFAULT_D);

  const lambda = (own.orders + M_HOURS * lambdaPrior) / (own.idleHours + M_HOURS);
  const V = (own.sumNetFare + M_ORDERS * vPrior) / (own.fareOrders + M_ORDERS);
  const D = (own.sumOrderMinutes + M_ORDERS * dPrior) / (own.durOrders + M_ORDERS);
  const shrink = M_HOURS / (own.idleHours + M_HOURS);
  const offers = own.orders + own.declined;
  return {
    cell,
    lambda,
    V,
    D,
    W: Math.min(MAX_WAIT_MIN, lambda > 0 ? 60 / lambda : MAX_WAIT_MIN),
    offerRate: rate(offers, own.idleHours),
    declineRatio: rate(own.declined, offers),
    idleHours: own.idleHours,
    orders: own.orders,
    nearbyHours: own.idleHours + ring.idleHours,
    nearbyOrders: own.orders + ring.orders,
    shrink,
    confidence: shrink > 0.7 ? 'low' : shrink < 0.3 ? 'high' : 'mid',
  };
}

/**
 * 資料夠不夠顯示（4.5）：附近空車時數 ≥ 1 小時，或附近接過 ≥ 3 單。
 * 只看時數的話，越熱門的地方（很快就接到單）累積的空車時數越少，反而會被藏起來。
 */
export const hasEnoughData = (e: CellEstimate): boolean => e.nearbyHours >= 1 || e.nearbyOrders >= 3;

export interface Candidate extends CellEstimate {
  center: LatLon;
  distKm: number;
  /** 直線距離（雷達上畫點用） */
  straightKm: number;
  bearing: number;
  /** 開過去（分） */
  T: number;
  cost: number;
  /** 預期時薪（元） */
  score: number;
  here: boolean;
}

export interface Recommendation {
  slot: Slot;
  candidates: Candidate[];
  here: Candidate;
  best: Candidate;
  /** 原地分數與第一名差距 < 10% 時建議原地等候 */
  stay: boolean;
  /** 雷達範圍（maxRadarKm）外、有資料的熱點，由近到遠 */
  far: Candidate[];
  tripCount: number;
  enough: boolean;
}

export function scoreCell(est: CellEstimate, from: LatLon, here: boolean, settings: Settings): Candidate {
  const [lat, lon] = cellToLatLng(est.cell);
  const center = { lat, lon };
  const straightKm = here ? 0 : distanceM(from, center) / 1000;
  const distKm = straightKm * settings.roadFactor;
  const T = (distKm / settings.avgSpeedKmh) * 60;
  const cost = distKm * settings.costPerKm;
  const score = ((est.V - cost) / (T + est.W + est.D)) * 60;
  return { ...est, center, distKm, straightKm, bearing: bearingDeg(from, center), T, cost, score, here };
}

/** 雷達推薦（4.5）：範圍內每個資料夠的格子，加上原地不動，依預期時薪排序 */
export function recommend(index: StatsIndex, slot: Slot, from: LatLon, settings: Settings): Recommendation {
  const view = viewAt(index, slot, settings.importWeight);
  const hereCell = latLngToCell(from.lat, from.lon, index.res);
  const here = scoreCell(estimate(view, hereCell, settings), from, true, settings);
  const candidates: Candidate[] = [here];
  const far: Candidate[] = [];
  for (const cell of view.cells.keys()) {
    if (cell === hereCell) continue;
    const est = estimate(view, cell, settings);
    if (!hasEnoughData(est)) continue;
    const c = scoreCell(est, from, false, settings);
    if (c.straightKm > settings.maxRadarKm) far.push(c);
    else candidates.push(c);
  }
  // 雷達範圍外的熱點：由近到遠，附近都沒資料時拿來指方向
  far.sort((a, b) => a.straightKm - b.straightKm);
  candidates.sort((a, b) => b.score - a.score);
  // 原地沒有自己的資料時，它的分數只是全城平均，不能拿來建議「原地等候」
  const hereKnown = hasEnoughData(here);
  const ranked = hereKnown ? candidates : candidates.filter((c) => !c.here);
  const best = ranked[0] ?? here;
  return {
    slot,
    candidates: ranked,
    here,
    best,
    stay: best.here || (hereKnown && here.score >= best.score * 0.9),
    far: far.slice(0, 40),
    tripCount: index.tripCount,
    enough: index.tripCount >= MIN_TRIPS,
  };
}
