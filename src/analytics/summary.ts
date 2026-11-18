// 統計頁的表格（SPEC 5.3 Phase 3 版）：最佳時段、最佳格子、每週時薪、本月總覽、挑單分析。純函式。
import { cellToLatLng } from 'h3-js';
import type { DeclineReason, Fare, ImportedIdle, ImportedTrip, Settings, TripEvent } from '../db/types';
import { deriveSegments, liveEvents } from '../domain/state';
import { estimate, hasEnoughData, viewAt } from './model';
import { DAY_TYPES, taipeiParts, type Slot } from './slots';
import { emptyAcc, netFare, type Acc, type StatsIndex } from './stats';

export interface SlotRank {
  slot: Slot;
  /** 不含開車過去的預期時薪 */
  hourly: number;
  waitMin: number;
  perOrder: number;
  orders: number;
  idleHours: number;
}

/** 全城每個槽位的預期時薪（混合相鄰時段、往全部資料收縮） */
export function bestSlots(index: StatsIndex, settings: Settings, top = 10): SlotRank[] {
  const out: SlotRank[] = [];
  for (const day of DAY_TYPES) {
    for (let h = 0; h < 24; h++) {
      const slot: Slot = `${day}:${h}`;
      const v = viewAt(index, slot, settings.importWeight);
      const c = v.city;
      if (c.idleHours < 1 && c.orders < 3) continue;
      const lam = (c.orders + 2 * rate(v.cityAll.orders, v.cityAll.idleHours, 1)) / (c.idleHours + 2);
      const V = (c.sumNetFare + 3 * rate(v.cityAll.sumNetFare, v.cityAll.fareOrders, 200)) / (c.fareOrders + 3);
      const D = (c.sumOrderMinutes + 3 * rate(v.cityAll.sumOrderMinutes, v.cityAll.durOrders, 25)) / (c.durOrders + 3);
      const W = 60 / lam;
      out.push({ slot, hourly: (V / (W + D)) * 60, waitMin: W, perOrder: V, orders: c.orders, idleHours: c.idleHours });
    }
  }
  return out.sort((a, b) => b.hourly - a.hourly).slice(0, top);
}

const rate = (n: number, d: number, fb: number) => (d > 0 ? n / d : fb);

export interface CellRank {
  cell: string;
  center: { lat: number; lon: number };
  hourly: number;
  waitMin: number;
  perOrder: number;
  orders: number;
  idleHours: number;
  confidence: 'low' | 'mid' | 'high';
}

/** 不分時段的最佳格子（把所有槽位加總成一個「全時段」視角） */
export function bestCells(index: StatsIndex, settings: Settings, top = 10): CellRank[] {
  const merged = new Map<string, Acc>();
  for (const m of index.cells.values()) {
    for (const [cell, a] of m) {
      let t = merged.get(cell);
      if (!t) merged.set(cell, (t = emptyAcc()));
      t.idleHours += a.idleHours;
      t.orders += a.orders;
      t.declined += a.declined;
      t.sumNetFare += a.sumNetFare;
      t.fareOrders += a.fareOrders;
      t.sumOrderMinutes += a.sumOrderMinutes;
      t.durOrders += a.durOrders;
    }
  }
  const all = emptyAcc();
  for (const a of merged.values()) {
    for (const k of Object.keys(all) as (keyof Acc)[]) all[k] += a[k];
  }
  for (const o of index.official?.values() ?? []) {
    for (const k of Object.keys(all) as (keyof Acc)[]) all[k] += o[k] * settings.importWeight;
  }
  // 借用 estimate：把「全時段」當成一個槽位
  const view = { slot: 'weekday:0' as Slot, cells: merged, video: new Map(), city: all, cityAll: all };
  const out: CellRank[] = [];
  for (const cell of merged.keys()) {
    const e = estimate(view, cell, settings);
    // 只接過一兩單的格子信心太低，排行榜上容易誤導
    if (!hasEnoughData(e) || e.orders < 3) continue;
    const [lat, lon] = cellToLatLng(cell);
    out.push({
      cell,
      center: { lat, lon },
      hourly: (e.V / (e.W + e.D)) * 60,
      waitMin: e.W,
      perOrder: e.V,
      orders: e.orders,
      idleHours: e.idleHours,
      confidence: e.confidence,
    });
  }
  return out.sort((a, b) => b.hourly - a.hourly).slice(0, top);
}

export interface Period {
  key: string;
  trips: number;
  earnings: number;
  surge: number;
  fareSum: number;
  onlineHours: number;
  hourly: number | null;
}

const MS_H = 3_600_000;

/** Uber 官方資料（沒有和自己按鈕記錄重疊的部分），讓統計頁也看得到歷史 */
export interface OfficialHistory {
  trips: readonly ImportedTrip[];
  idle: readonly ImportedIdle[];
}

function periodsBy(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  settings: Settings,
  keyOf: (ts: number) => string,
  now: number,
  official?: OfficialHistory,
): Period[] {
  const map = new Map<string, Period>();
  const get = (k: string) => {
    let p = map.get(k);
    if (!p) map.set(k, (p = { key: k, trips: 0, earnings: 0, surge: 0, fareSum: 0, onlineHours: 0, hourly: null }));
    return p;
  };
  const live = liveEvents(events);
  let onlineAt: number | null = null;
  for (const e of live) {
    if (e.type === 'online') onlineAt = e.ts;
    else if (e.type === 'offline' && onlineAt != null) {
      get(keyOf(onlineAt)).onlineHours += (e.ts - onlineAt) / MS_H;
      onlineAt = null;
    } else if (e.type === 'dropoff') {
      const p = get(keyOf(e.ts));
      p.trips++;
      const f = fares.get(e.id);
      if (f && !f.deleted && f.fare != null) {
        p.earnings += netFare(f, settings);
        p.fareSum += f.fare;
        p.surge += f.surge ?? 0;
      }
    }
  }
  if (onlineAt != null) get(keyOf(onlineAt)).onlineHours += (now - onlineAt) / MS_H;

  if (official) {
    // 自己有按按鈕的班別以自己的記錄為準，官方資料只補沒有記錄的時間
    const shifts: [number, number][] = [];
    let on: number | null = null;
    for (const e of live) {
      if (e.type === 'online') on = e.ts;
      else if (e.type === 'offline' && on != null) {
        shifts.push([on, e.ts]);
        on = null;
      }
    }
    if (on != null) shifts.push([on, now]);
    const covered = (t: number) => shifts.some(([a, b]) => t >= a && t <= b);
    // 上線時數 ≈ 空車時間 ＋ 每趟從接單到下客
    for (const t of official.trips) {
      if (t.source !== 'uber_zip' || t.requestTs == null || covered(t.requestTs)) continue;
      const p = get(keyOf(t.requestTs));
      p.trips++;
      p.earnings += (t.fare ?? 0) + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
      p.fareSum += t.fare ?? 0;
      p.surge += t.surge ?? 0;
      if (t.dropoffTs != null && t.dropoffTs > t.requestTs) p.onlineHours += (t.dropoffTs - t.requestTs) / MS_H;
    }
    for (const i of official.idle) {
      if (covered(i.start)) continue;
      get(keyOf(i.start)).onlineHours += (i.end - i.start) / MS_H;
    }
  }

  for (const p of map.values()) p.hourly = p.onlineHours >= 0.1 ? p.earnings / p.onlineHours : null;
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

/** ISO 週（台北時間，週一開始），鍵是那一週週一的日期 */
export function weekKey(ts: number): string {
  const { dow } = taipeiParts(ts);
  const monday = ts - ((dow + 6) % 7) * 24 * MS_H;
  return taipeiParts(monday).dateKey;
}

export const monthKey = (ts: number): string => taipeiParts(ts).dateKey.slice(0, 7);

export function weekly(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  settings: Settings,
  now: number,
  weeks = 8,
  official?: OfficialHistory,
): Period[] {
  return periodsBy(events, fares, settings, weekKey, now, official).slice(0, weeks);
}

export function monthly(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  settings: Settings,
  now: number,
  official?: OfficialHistory,
): Period[] {
  return periodsBy(events, fares, settings, monthKey, now, official);
}

export interface DeclineStats {
  total: number;
  byReason: Record<Exclude<DeclineReason, null> | 'none', number>;
  /** 拒單後到下一次接單的平均分鐘 */
  afterDeclineWaitMin: number | null;
  /** 所有空車段從開始到接單的平均分鐘（對照組） */
  avgWaitMin: number | null;
}

export function declineStats(events: readonly TripEvent[]): DeclineStats {
  const live = liveEvents(events);
  const byReason = { too_far: 0, low_fare: 0, wrong_direction: 0, none: 0 };
  let total = 0;
  const after: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const e = live[i]!;
    if (e.type !== 'offer_declined') continue;
    total++;
    byReason[e.declineReason ?? 'none']++;
    // 同一個空車段裡的下一次接單
    for (let j = i + 1; j < live.length; j++) {
      const n = live[j]!;
      if (n.type === 'offer_declined') continue;
      if (n.type === 'accept') after.push((n.ts - e.ts) / 60_000);
      break;
    }
  }
  const waits = deriveSegments(live)
    .filter((s) => s.kind === 'idle' && s.end?.type === 'accept')
    .map((s) => (s.end!.ts - s.start.ts) / 60_000);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { total, byReason, afterDeclineWaitMin: avg(after), avgWaitMin: avg(waits) };
}
