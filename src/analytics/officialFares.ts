// 按鈕記錄的下客沒有填車資時，用 Uber 官方資料裡同一趟的司機實收補上（純函式）。
import type { Fare, ImportedTrip, TripEvent } from '../db/types';
import { liveEvents } from '../domain/state';
import { driverEarnings, regionAt, trackKm, type Product } from './uberRates';

const DAY_MS = 86_400_000;

/** 按鈕下客和官方下客時間相差在這之內就當成同一趟 */
export const FARE_MATCH_MS = 3 * 60_000;

/** 最近 days 天官方行程的平均司機實收（記錄頁拿來估還沒有車資的趟）；資料不夠時往更早找，都沒有回傳 null */
export function avgRecentFare(official: readonly ImportedTrip[], now: number, days = 60): number | null {
  const priced = official.filter((t) => t.source === 'uber_zip' && t.fare != null && t.requestTs != null);
  const recent = priced.filter((t) => t.requestTs! >= now - days * 86_400_000);
  const use = recent.length >= 20 ? recent : priced;
  return use.length ? use.reduce((s, t) => s + t.fare!, 0) / use.length : null;
}

/**
 * 回傳新的車資表：自己填過的車資保留不動，只替「沒填」或「待補」的下客補上官方車資。
 * 每筆官方行程最多配給一個下客，時間最接近的優先。
 */
export function withOfficialFares(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  official: readonly ImportedTrip[],
): Map<string, Fare> {
  const out = new Map(fares);
  const trips = official
    .filter((t) => t.source === 'uber_zip' && t.dropoffTs != null && t.fare != null);
  if (!trips.length) return out;
  // 所有「差距在門檻內」的配對，由最接近的開始配，每筆官方行程、每個下客都只用一次
  const pairs: { e: TripEvent; t: ImportedTrip; d: number }[] = [];
  for (const e of liveEvents(events)) {
    if (e.type !== 'dropoff') continue;
    const f = fares.get(e.id);
    if (f && !f.deleted && !f.pending && f.fare != null) continue;
    for (const t of trips) {
      const d = Math.abs(t.dropoffTs! - e.ts);
      if (d <= FARE_MATCH_MS) pairs.push({ e, t, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedTrip = new Set<string>();
  const usedEvent = new Set<string>();
  for (const { e, t } of pairs) {
    if (usedTrip.has(t.id) || usedEvent.has(e.id)) continue;
    usedTrip.add(t.id);
    usedEvent.add(e.id);
    out.set(e.id, {
      id: e.id,
      fare: t.fare,
      surge: t.surge,
      tip: null,
      note: '',
      pending: false,
      updatedAt: fares.get(e.id)?.updatedAt ?? 0,
    });
  }
  return out;
}

/** 車資 ≈ a ＋ b × 載客分鐘（用官方行程做最小平方法） */
export interface FareModel {
  a: number;
  b: number;
  n: number;
}

/** 用最近 days 天（不足 30 趟就用全部）官方行程的載客時間與實收擬合；資料太少回傳 null */
export function fitFareModel(official: readonly ImportedTrip[], now: number, days = 90): FareModel | null {
  const usable = official.filter(
    (t) => t.source === 'uber_zip' && t.fare != null && t.durationSec != null && t.durationSec > 0 && t.requestTs != null,
  );
  const recent = usable.filter((t) => t.requestTs! >= now - days * DAY_MS);
  const use = recent.length >= 30 ? recent : usable;
  if (use.length < 10) return null;
  const xs = use.map((t) => t.durationSec! / 60);
  const ys = use.map((t) => t.fare!);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
  });
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b, n: use.length };
}

/** 一趟的估計實收：有載客時間就用模型，沒有就用平均；不低於官方資料裡最常見的低消附近 */
export function estimateFare(model: FareModel | null, minutes: number | null, avg: number | null): number | null {
  if (model && minutes != null && minutes > 0) return Math.max(70, model.a + model.b * minutes);
  return avg;
}

/** 本班還沒有車資的趟，逐趟估實收後加總：
 * 1. 有 GPS 軌跡算得出里程：用 Uber 費率公式（地區看上客位置、車種看接單時選的）
 * 2. 沒有軌跡但有載客時間：用官方資料擬合的「每分鐘多少錢」
 * 3. 都沒有：用最近平均
 */
export function estimateUnpriced(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  shiftId: string,
  model: FareModel | null,
  avg: number | null,
  tracks: readonly { ts: number; lat: number; lon: number }[] = [],
): number | null {
  let pickup: TripEvent | null = null;
  let product: Product = 'standard';
  let sum = 0;
  for (const e of liveEvents(events)) {
    if (e.shiftId !== shiftId) continue;
    if (e.type === 'accept') product = e.product ?? 'standard';
    else if (e.type === 'pickup') pickup = e;
    else if (e.type === 'cancel') pickup = null;
    else if (e.type === 'dropoff') {
      const f = fares.get(e.id);
      if (!(f && !f.deleted && f.fare != null)) {
        const minutes = pickup ? (e.ts - pickup.ts) / 60_000 : null;
        const km = pickup ? trackKm(tracks, pickup.ts, e.ts) : null;
        let est: number | null;
        if (pickup && minutes != null && km != null) {
          const at = pickup.lat != null && pickup.lon != null ? pickup : e;
          const region = at.lat != null && at.lon != null ? regionAt(at.lat, at.lon) : 'taoyuan';
          est = driverEarnings(region, product, km, minutes);
        } else {
          est = estimateFare(model, minutes, avg);
        }
        if (est == null) return null;
        sum += est;
      }
      pickup = null;
      product = 'standard';
    }
  }
  return sum;
}
