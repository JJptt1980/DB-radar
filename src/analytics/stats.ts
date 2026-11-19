// 每個 H3 格子 × 槽位的統計量（SPEC 4.2、4.6）。純函式。
import { latLngToCell } from 'h3-js';
import type { Fare, ImportedIdle, ImportedTrip, Settings, TrackPoint, TripEvent } from '../db/types';
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
  /** Uber 官方資料裡沒有地點的部分（全城層級，分析時乘上 importWeight） */
  official: Map<Slot, Acc>;
  /** 有地點的完成趟數：自己按鈕記錄的，加上官方資料裡有定位的空車時段接到的單 */
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
  idle?: readonly ImportedIdle[];
  settings: Settings;
  now?: number;
}

export function netFare(f: Fare, settings: Settings): number {
  return (f.fare ?? 0) + (f.tip ?? 0) + (settings.fareIncludesSurge ? 0 : (f.surge ?? 0));
}

/**
 * 接單偏好（長單／短單）：回傳「這張單要不要算」。
 * 不要的單，視為司機會拒掉繼續等：空車時間照算，但不算接到單，也不算進每單實收與耗時，
 * 所以只要長單時，雷達會推薦「長單多、等得到長單」的地方。車資未知的單照算（無法分類）。
 */
export function orderFilter(settings: Settings): (fare: number | null | undefined) => boolean {
  const long = settings.wantLong ?? true;
  const short = settings.wantShort ?? true;
  if (long === short) return () => true;
  const min = settings.longFareMin ?? 300;
  return (fare) => fare == null || (long ? fare >= min : fare < min);
}

export function buildStats(input: StatsInput): StatsIndex {
  const { settings } = input;
  const wanted = orderFilter(settings);
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
  const official = new Map<Slot, Acc>();
  const oacc = (slot: Slot): Acc => {
    let a = official.get(slot);
    if (!a) official.set(slot, (a = emptyAcc()));
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

  /** 把一段時間加到格子上（cell = null 表示官方資料沒有地點，加到全城層），跨整點時拆開 */
  const addTime = (cell: string | null, from: number, to: number) => {
    let t = from;
    while (t < to) {
      const end = Math.min(to, nextHour(t));
      const slot = slotOf(t, holidays);
      (cell ? acc(slot, cell) : oacc(slot)).idleHours += (end - t) / 3_600_000;
      t = end;
    }
  };
  /** 依軌跡把一段空車時間分到格子：相鄰兩點不同格時各分一半 */
  const addPath = (nodes: { ts: number; cell: string }[]) => {
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
    addPath(nodes);
  }

  // 接單：找出這張單的結果（取消算 0 元；下客取車資）
  const segByStart = new Map<string, Segment>();
  for (const s of segments) segByStart.set(s.start.id, s);
  for (const seg of segments) {
    if (seg.kind !== 'idle' || seg.end?.type !== 'accept') continue;
    const accept = seg.end;
    const ap = pos(accept);
    if (!ap) continue;
    const approach = segByStart.get(accept.id);
    // 先找出這張單的實收，用來判斷長短單
    const dropEvt =
      approach?.end?.type === 'pickup' ? segByStart.get(approach.end.id)?.end : null;
    const dropFare = dropEvt?.type === 'dropoff' ? input.fares.get(dropEvt.id) : undefined;
    const orderFare =
      approach?.end?.type === 'cancel'
        ? 0
        : dropFare && !dropFare.deleted && !dropFare.pending && dropFare.fare != null
          ? netFare(dropFare, settings)
          : null;
    if (!wanted(orderFare)) continue;
    const a = acc(slotOf(accept.ts, holidays), cellOf(ap.lat, ap.lon));
    a.orders++;
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

  // 影片行程：上一趟下車到下一趟接單的空檔當作空車時間，歸在前一趟的下車格子（4.6）。
  // 卡片時間是接單時間；下車時間有官方資料就用官方的，沒有就用「接單＋行程時長」估（會少算接駁時間，空檔略為高估）。
  const reqOf = (t: ImportedTrip) => t.requestTs ?? t.pickupTs;
  const dropOf = (t: ImportedTrip) =>
    t.dropoffTs ?? (reqOf(t) != null && t.durationSec != null ? reqOf(t)! + t.durationSec * 1000 : null);
  const vids = input.imported
    .filter((t) => t.source === 'video' && !t.matchedDropoffEventId && reqOf(t) != null && dropOf(t) != null)
    .sort((a, b) => reqOf(a)! - reqOf(b)!);
  for (let i = 0; i < vids.length; i++) {
    const t = vids[i]!;
    const tFare = t.fare == null ? null : t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
    const tWanted = wanted(tFare);
    if (tWanted && t.fare != null && t.pickupLat != null && t.pickupLon != null && CELL_PRECISION.has(t.pickupPrecision ?? '')) {
      const v = vacc(slotOf(reqOf(t)!, holidays), cellOf(t.pickupLat, t.pickupLon));
      v.sumFare += t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
      v.fareOrders++;
    }
    const prev = vids[i - 1];
    if (!prev || taipeiParts(reqOf(prev)!).dateKey !== taipeiParts(reqOf(t)!).dateKey) continue;
    const prevDrop = dropOf(prev)!;
    const gapMin = (reqOf(t)! - prevDrop) / 60_000;
    if (gapMin < 0 || gapMin > settings.gapBreakMin) continue;
    if (prev.dropoffLat == null || prev.dropoffLon == null || !CELL_PRECISION.has(prev.dropoffPrecision ?? '')) continue;
    const v = vacc(slotOf(prevDrop, holidays), cellOf(prev.dropoffLat, prev.dropoffLon));
    v.idleHours += gapMin / 60;
    // 不要的單（例如只要長單時的短單）：空檔照算，但不算接到單
    if (tWanted) v.orders++;
  }

  // ---------- Uber 官方資料（SPEC 4.6，2026-11-19 依真實檔案修訂） ----------
  // 自己按按鈕記錄的班別時間；官方資料落在這些時間裡的不重複計算
  const shifts: [number, number][] = [];
  let onAt: number | null = null;
  for (const e of live) {
    if (e.type === 'online') onAt = e.ts;
    else if (e.type === 'offline' && onAt != null) {
      shifts.push([onAt, e.ts]);
      onAt = null;
    }
  }
  if (onAt != null) shifts.push([onAt, input.now ?? Date.now()]);
  const covered = (a: number, b: number) => shifts.some(([s, e]) => a < e && b > s);

  const officialTrips = input.imported
    .filter((t) => t.source === 'uber_zip' && t.requestTs != null && !covered(t.requestTs, t.requestTs + 1))
    .sort((a, b) => a.requestTs! - b.requestTs!);
  // 每一單的實收與耗時（接單到下客）：放進全城層，當作 V、D 的先驗
  const tripFare = (t: ImportedTrip | null) => (t?.fare == null ? null : t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0)));
  for (const t of officialTrips) {
    if (!wanted(tripFare(t))) continue;
    const a = oacc(slotOf(t.requestTs!, holidays));
    if (t.fare != null) {
      a.sumNetFare += t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
      a.fareOrders++;
    }
    if (t.dropoffTs != null && t.dropoffTs > t.requestTs!) {
      a.sumOrderMinutes += (t.dropoffTs - t.requestTs!) / 60_000;
      a.durOrders++;
    }
  }
  /** 空車時段結束（接單）時對應的官方行程 */
  const tripAt = (ts: number) => {
    let lo = 0;
    let hi = officialTrips.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (officialTrips[m]!.requestTs! < ts - 120_000) lo = m + 1;
      else hi = m;
    }
    const t = officialTrips[lo];
    return t && Math.abs(t.requestTs! - ts) <= 120_000 ? t : null;
  };

  let locatedOrders = 0;
  for (const p of input.idle ?? []) {
    if (p.end <= p.start || p.end - p.start > MAX_IDLE_MS || covered(p.start, p.end)) continue;
    const path = (p.path ?? []).filter(([ts]) => ts >= p.start && ts <= p.end);
    if (!path.length) {
      // 沒有地點：只進全城層，回答「哪個時段好」
      addTime(null, p.start, p.end);
      if (p.endedWithOrder && wanted(tripFare(tripAt(p.end)))) oacc(slotOf(p.end, holidays)).orders++;
      continue;
    }
    // 有 GPS 軌跡（最近 30 天）：和自己的記錄一樣算進格子，權重 1
    const nodes = path.map(([ts, lat, lon]) => ({ ts, cell: cellOf(lat, lon) }));
    if (nodes[0]!.ts > p.start) nodes.unshift({ ts: p.start, cell: nodes[0]!.cell });
    if (nodes[nodes.length - 1]!.ts < p.end) nodes.push({ ts: p.end, cell: nodes[nodes.length - 1]!.cell });
    addPath(nodes);
    if (!p.endedWithOrder) continue;
    locatedOrders++;
    const t = tripAt(p.end);
    if (!wanted(tripFare(t))) continue;
    const a = acc(slotOf(p.end, holidays), nodes[nodes.length - 1]!.cell);
    a.orders++;
    if (t?.fare != null) {
      a.sumNetFare += t.fare + (settings.fareIncludesSurge ? 0 : (t.surge ?? 0));
      a.fareOrders++;
    }
    if (t?.dropoffTs != null && t.dropoffTs > p.end) {
      a.sumOrderMinutes += (t.dropoffTs - p.end) / 60_000;
      a.durOrders++;
    }
  }

  return {
    res,
    cells,
    video,
    official,
    tripCount: live.filter((e) => e.type === 'dropoff').length + locatedOrders,
    firstTs: live[0]?.ts ?? null,
  };
}
