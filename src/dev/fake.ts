// 開發用假資料（SPEC 第 9 章）。所有 id 與班別都以 dev- 開頭，可以單獨清除，不會碰到真實資料。
import type { Fare, TrackPoint, TripEvent } from '../db/types';
import type { LatLon } from '../domain/geo';
import { dayType, taipeiParts, type DayType } from '../analytics/slots';

export interface Zone {
  name: string;
  /** 相對中心的位移（公里，東、北） */
  east: number;
  north: number;
  /** 平常的接單率（單/小時） */
  base: number;
  peaks: { days: DayType[]; from: number; to: number; rate: number }[];
  /** 平均車資 */
  fare: number;
}

/** 熱區設計成可以人工驗證：週五 22 點應該是「夜生活區」第一 */
export const ZONES: Zone[] = [
  { name: '車站', east: 0.3, north: 0.2, base: 2.5, fare: 180,
    peaks: [{ days: ['weekday', 'fri'], from: 7, to: 9, rate: 9 }, { days: ['weekday'], from: 17, to: 19, rate: 8 }] },
  { name: '夜市', east: -1.6, north: 1.2, base: 2, fare: 150,
    peaks: [{ days: ['fri', 'sat', 'sun'], from: 18, to: 21, rate: 8 }] },
  { name: '商辦區', east: 2.2, north: -0.6, base: 2, fare: 230,
    peaks: [{ days: ['weekday'], from: 9, to: 18, rate: 5 }] },
  { name: '夜生活區', east: 1.4, north: 1.8, base: 1.5, fare: 280,
    peaks: [{ days: ['fri', 'sat'], from: 21, to: 24, rate: 12 }, { days: ['sat', 'sun'], from: 0, to: 2, rate: 10 }] },
  { name: '住宅區', east: -2.4, north: -1.8, base: 1.8, fare: 160,
    peaks: [{ days: ['sat', 'sun', 'holiday'], from: 9, to: 12, rate: 5 }] },
  { name: '醫院', east: -0.6, north: -2.6, base: 3, fare: 170, peaks: [] },
];

export function zoneRate(z: Zone, day: DayType, hour: number): number {
  for (const p of z.peaks) if (p.days.includes(day) && hour >= p.from && hour < p.to) return p.rate;
  return z.base;
}

/** 可重現的亂數（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KM_LAT = 1 / 110.574;
const kmLon = (lat: number) => 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
export const zoneCenter = (c: LatLon, z: Zone): LatLon => ({ lat: c.lat + z.north * KM_LAT, lon: c.lon + z.east * kmLon(c.lat) });

export interface FakeData {
  events: TripEvent[];
  fares: Fare[];
  tracks: TrackPoint[];
}

export interface FakeOptions {
  center: LatLon;
  /** 最後一天（不含）的台北 0 點 epoch ms */
  endDay: number;
  days?: number;
  seed?: number;
  holidays?: ReadonlySet<string>;
}

const MIN = 60_000;

export function generateFake(o: FakeOptions): FakeData {
  const R = rng(o.seed ?? 42);
  const holidays = o.holidays ?? new Set<string>();
  const days = o.days ?? 60;
  const events: TripEvent[] = [];
  const fares: Fare[] = [];
  const tracks: TrackPoint[] = [];
  let n = 0;
  const id = () => `dev-${(++n).toString(36)}`;
  const jitter = (p: LatLon, km: number): LatLon => ({
    lat: p.lat + (R() - 0.5) * 2 * km * KM_LAT,
    lon: p.lon + (R() - 0.5) * 2 * km * kmLon(p.lat),
  });
  const exp = (rate: number) => -Math.log(1 - R()) / rate;

  for (let d = days; d >= 1; d--) {
    const shiftId = `dev-shift-${d}`;
    const dayStart = o.endDay - d * 24 * 60 * MIN;
    // 每天一班：開始時間 6～20 點，長度 5～8 小時；週五週六晚上比較常跑夜班
    const dow = taipeiParts(dayStart + 12 * 60 * MIN).dow;
    const night = (dow === 5 || dow === 6) && R() < 0.8;
    const startHour = night ? 18 + Math.floor(R() * 3) : 6 + Math.floor(R() * 14);
    let t = dayStart + startHour * 60 * MIN + Math.floor(R() * 30) * MIN;
    const end = t + (5 + R() * 3) * 60 * MIN;
    let here = jitter(o.center, 0.5);

    const ev = (type: TripEvent['type'], ts: number, p: LatLon, extra: Partial<TripEvent> = {}) => {
      const e: TripEvent = {
        id: id(), shiftId, type, ts, lat: p.lat, lon: p.lon, accuracy: 10, source: 'button', updatedAt: ts, ...extra,
      };
      events.push(e);
      return e;
    };
    const track = (from: number, to: number, a: LatLon, b: LatLon) => {
      for (let s = from; s < to; s += 30_000) {
        const f = (s - from) / Math.max(1, to - from);
        const p = jitter({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, 0.03);
        tracks.push({ id: id(), shiftId, ts: s, lat: p.lat, lon: p.lon, accuracy: 12, speed: null, heading: null, updatedAt: s });
      }
    };

    ev('online', t, here);
    while (t < end) {
      // 選一個熱區去等：像真的司機一樣偏好當下比較好接單的地方，但每個熱區都還是會去
      const day0 = dayType(t, holidays);
      const h0 = taipeiParts(t).hour;
      const weights = ZONES.map((zz) => zoneRate(zz, day0, h0));
      let pickW = R() * weights.reduce((x, y) => x + y, 0);
      let zi = 0;
      while (zi < ZONES.length - 1 && (pickW -= weights[zi]!) > 0) zi++;
      const z = ZONES[zi]!;
      const spot = jitter(zoneCenter(o.center, z), 0.12);
      const driveMin = 3 + R() * 4;
      track(t, t + driveMin * MIN, here, spot);
      t += driveMin * MIN;
      here = spot;
      // 等單：派單率 = 接單率 / 0.8，其中 20% 拒單
      for (;;) {
        const day = dayType(t, holidays);
        const rate = zoneRate(z, day, taipeiParts(t).hour) / 0.8;
        const wait = exp(rate) * 60 * MIN;
        track(t, t + wait, here, here);
        t += wait;
        if (t >= end) break;
        if (R() < 0.2) {
          ev('offer_declined', t, here, { declineReason: (['too_far', 'low_fare', 'wrong_direction', null] as const)[Math.floor(R() * 4)]! });
          continue;
        }
        break;
      }
      if (t >= end) break;
      ev('accept', t, here);
      const approach = (3 + R() * 6) * MIN;
      const pick = jitter(here, 0.6);
      track(t, t + approach, here, pick);
      t += approach;
      if (R() < 0.05) {
        ev('cancel', t, pick);
        here = pick;
        continue;
      }
      ev('pickup', t, pick);
      const distKm = 1.5 + R() * 8;
      const drop = jitter(pick, distKm / 1.4);
      const tripMin = distKm * 2.2 + R() * 6;
      track(t, t + tripMin * MIN, pick, drop);
      t += tripMin * MIN;
      const dropEv = ev('dropoff', t, drop);
      const surge = R() < 0.15 ? Math.round(30 + R() * 80) : 0;
      const fare = Math.round(z.fare * (0.7 + R() * 0.6) + distKm * 12) + surge;
      fares.push({ id: dropEv.id, fare, surge, tip: R() < 0.08 ? 20 : null, note: '', pending: false, updatedAt: t });
      here = drop;
    }
    // 等單等到超過下班時間就在下班時間下線；最後一趟跑超過的話，送完客才下線
    const lastTs = events[events.length - 1]!.ts;
    ev('offline', Math.max(lastTs + MIN, Math.min(t, end)), here);
  }
  return { events, fares, tracks };
}
