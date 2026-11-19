// 按鈕記錄的下客沒有填車資時，用 Uber 官方資料裡同一趟的司機實收補上（純函式）。
import type { Fare, ImportedTrip, TripEvent } from '../db/types';
import { liveEvents } from '../domain/state';

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
