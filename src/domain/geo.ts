export interface LatLon {
  lat: number;
  lon: number;
}

/** 兩點直線距離（公尺）。 */
export function distanceM(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 是否要寫一筆軌跡點（SPEC 3.1）：間隔到了，而且移動超過 20 公尺。 */
export function shouldRecordTrack(
  prev: { ts: number; lat: number; lon: number } | null,
  next: { ts: number; lat: number; lon: number },
  intervalSec: number,
  minMoveM = 20,
): boolean {
  if (!prev) return true;
  if (next.ts - prev.ts < intervalSec * 1000) return false;
  return distanceM(prev, next) >= minMoveM;
}

/** 從 a 看 b 的方位角（度，0 = 北，順時針） */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];

export function compassLabel(deg: number): string {
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}
