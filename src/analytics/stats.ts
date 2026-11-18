// 每個 H3 格子 × 槽位的統計量（SPEC 4.2、4.6）。純函式。
import { latLngToCell } from 'h3-js';
import type { Fare, ImportedTrip, Settings, TrackPoint, TripEvent } from '../db/types';
import { deriveSegments, liveEvents, type Segment } from '../domain/state';
import { nextHour, slotOf, taipeiParts, type Slot } from './slots';

export interface Acc {
  /** 空車時數 */
  idleHours: number;
  /** 空車段以接單結束、接單位置在這格的次數 */
  orders: number;
  /** 拒單次數 */
  declined: number;
  /** 已知車資的單的實收合計（取消單算 0） */
  sumNetFare: number;
  fareOrders: number;
  /** 接單到下客（或取消）的分鐘合計 */
  sumOrderMinutes: number;
  durOrders: number;
}

export interface VideoAcc {
  idleHours: number;
  orders: number;
  sumFare: number;
  fareOrders: number;
}

export type CellMap<T> = Map<string, T>;

export interface StatsIndex {
  res: number;
  cells: Map<Slot, CellMap<Acc>>;
  video: Map<Slot, CellMap<VideoAcc>>;
  /** 自己按鈕記錄完成的趟數 */
  tripCount: number;
  firstTs: number | null;
}

export const emptyAcc = (): Acc => ({
  idleHours: 0,
  orders: 0,
  declined: 0,
  sumNetFare: 0,
  fareOrders: 0,
  sumOrderMinutes: 0,
  durOrders: 0,
});
export const emptyVideo = (): VideoAcc => ({ idleHours: 0, orders: 0, sumFare: 0, fareOrders: 0 });

/** 可以進格子統計的地點精度（只到路名、里、區的不放進 res 8 的格子，見 8.3 步驟 6） */
const CELL_PRECISION = new Set(['gps', 'manual', 'address', 'lane', 'poi']);
const MAX_ACCURACY_M = 100;
/** 空車段超過這麼久就當作資料有問題（多半是忘了按下線） */
export const MAX_IDLE_MS = 4 * 3_600_000;

export interface StatsInput {
  events: readonly TripEvent[];
  fares: ReadonlyMap<string, Fare>;
  tracks: readonly TrackPoint[];
  imported: readonly ImportedTrip[];
  settings: Settings;
}

export function netFare(f: Fare, settings: Settings): number {
  return (f.fare ?? 0) + (f.tip ?? 0) + (settings.fareIncludesSurge ? 0 : (f.surge ?? 0));
}

export function buildStats(input: StatsInput): StatsIndex {
  const { settings } = input;
  const res = settings.h3Res;
  const holidays = new Set(settings.holidays);
  const cells = new Map<Slot, CellMap<Acc>>();
  const video = new Map<Slot, CellMap<VideoAcc>>();

  const acc = (slot: Slot, cell: string): Acc => {
    let m = cells.get(slot);
    if (!m) cells.set(slot, (m = new Map()));
    let a = m.get(cell);
    if (!a) m.set(cell, (a = emptyAcc()));
    return a;
  };
  const vacc = (slot: Slot, cell: string): VideoAcc => {
    let m = video.get(slot);
    if (!m) video.set(slot, (m = new Map()));
    let a = m.get(cell);
    if (!a) m.set(cell, (a = emptyVideo()));
    return a;
  };
  const cellOf = (lat: number, lon: number) => latLngToCell(lat, lon, res);

  /** 把一段時間加到格子上，跨整點時拆開，各自歸到自己的槽位 */
  const addTime = (cell: string, from: number, to: number) => {
    let t = from;
    while (t < to) {
      const end = Math.min(to, nextHour(t));
      acc(slotOf(t, holidays), cell).idleHours += (end - t) / 3_600_000;
      t = end;
    }
  };

  const live = liveEvents(input.events);
  const segments = deriveSegments(live);

  // 軌跡依班別分組，去掉精度太差的點
  const tracksByShift = new Map<string, TrackPoint[]>();
  for (const p of input.tracks) {
    if (p.accuracy > MAX_ACCURACY_M) continue;
    let arr = tracksByShift.get(p.shiftId);
    if (!arr) tracksByShift.set(p.shiftId, (arr = []));
    arr.push(p);
  }
  for (const arr of tracksByShift.values()) arr.sort((a, b) => a.ts - b.ts);

  const pos = (e: TripEvent) =>
    e.lat != null && e.lon != null && (e.accuracy == null || e.accuracy <= MAX_ACCURACY_M)
      ? { lat: e.lat, lon: e.lon }
      : null;

  // 空車時數：用空車段內的軌跡點歸屬；相鄰兩點不同格時各分一半（等同線性內插的近似）
  for (const seg of segments) {
    if (seg.kind !== 'idle' || !seg.end) continue;
    const t0 = seg.start.ts;
    const t1 = seg.end.ts;
    // 忘了按下線（空車段一直延到下一班上線）或長得不合理的空車段不算，避免灌爆等待時間
    if (t1 <= t0 || seg.end.type === 'online' || t1 - t0 > MAX_IDLE_MS) continue;
    const nodes: { ts: number; cell: string }[] = [];
    const sp = pos(seg.start);
    if (sp) nodes.push({ ts: t0, cell: cellOf(sp.lat, sp.lon) });
    for (const p of tracksByShift.get(seg.start.shiftId) ?? []) {
      if (p.ts > t0 && p.ts < t1) nodes.push({ ts: p.ts, cell: cellOf(p.lat, p.lon) });
    }
    const ep = pos(seg.end);
    if (ep) nodes.push({ ts: t1, cell: cellOf(ep.lat, ep.lon) });
    if (nodes.length === 0) continue;
    // 段首沒有位置時，用第一個已知位置往前補；段尾同理
    if (nodes[0]!.ts > t0) nodes.unshift({ ts: t0, cell: nodes[0]!.cell });
    if (nodes[nodes.length - 1]!.ts < t1) nodes.push({ ts: t1, cell: nodes[nodes.length - 1]!.cell });
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i]!;
      const b = nodes[i + 1]!;
      if (b.ts <= a.ts) continue;
      if (a.cell === b.cell) addTime(a.cell, a.ts, b.ts);
      else {
        const mid = (a.ts + b.ts) / 2;
        addTime(a.cell, a.ts, mid);
        addTime(b.cell, mid, b.ts);
      }
    }
  }

  // 接單：找出這張單的結果（取消算 0 元；下客取車資）
  const segByStart = new Map<string, Segment>();
  for (const s of segments) segByStart.set(s.start.id, s);
  for (const seg of segments) {
    if (seg.kind !== 'idle' || seg.end?.type !== 'accept') continue;
    const accept = seg.end;
    const ap = pos(accept);
    if (!ap) continue;
    const a = acc(slotOf(accept.ts, holidays), cellOf(ap.lat, ap.lon));
    a.orders++;
    const approach = segByStart.get(accept.id);
    if (!approach?.end) continue;
    if (approach.end.type === 'cancel') {
      a.fareOrders++;
      a.sumOrderMinutes += (approach.end.ts - accept.ts) / 60_000;
      a.durOrders++;
      continue;
    }
    if (approach.end.type !== 'pickup') continue;
    const trip = segByStart.get(approach.end.id);
    const drop = trip?.end;
    if (!drop || drop.type !== 'dropoff') continue;
    a.sumOrderMinutes += (drop.ts - accept.ts) / 60_000;
    a.durOrders++;
    const f = input.fares.get(drop.id);
    if (f && !f.deleted && !f.pending && f.fare != null) {
      a.sumNetFare += netFare(f, settings);
      a.fareOrders++;
    }
  }

  for (const e of live) {
    if (e.type !== 'offer_declined') continue;
    const p = pos(e);
    if (p) acc(slotOf(e.ts, holidays), cellOf(p.lat, p.lon)).declined++;
  }

  // 影片行程：相鄰兩趟的空檔當作「空車＋接駁」，歸在前一趟的下車格子（4.6）
  const vids = input.imported
    .filter((t) => t.source === 'video' && !t.matchedDropoffEventId && t.pickupTs != null && t.dropoffTs != null)
    .sort((a, b) => a.pickupTs! - b.pickupTs!);
  for (let i = 0; i < vids.length; i++) {
    const t = vids[i]!;
    if (t.fare != null && t.pickupLat != null && t.pickupLon != null && CELL_PRECISION.has(t.pickupPrecision ?? '')) {
      const v = vacc(slotOf(t.pickupTs!, holidays), cellOf(t.pickupLat, t.pickupLon));
      v.sumFare += t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
      v.fareOrders++;
    }
    const prev = vids[i - 1];
    if (!prev || taipeiParts(prev.pickupTs!).dateKey !== taipeiParts(t.pickupTs!).dateKey) continue;
    const gapMin = (t.pickupTs! - prev.dropoffTs!) / 60_000;
    if (gapMin < 0 || gapMin > settings.gapBreakMin) continue;
    if (prev.dropoffLat == null || prev.dropoffLon == null || !CELL_PRECISION.has(prev.dropoffPrecision ?? '')) continue;
    const v = vacc(slotOf(prev.dropoffTs!, holidays), cellOf(prev.dropoffLat, prev.dropoffLon));
    v.idleHours += gapMin / 60;
    v.orders++;
  }

  return {
    res,
    cells,
    video,
    tripCount: live.filter((e) => e.type === 'dropoff').length,
    firstTs: live[0]?.ts ?? null,
  };
}
