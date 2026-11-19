import { describe, expect, it } from 'vitest';
import { withOfficialFares } from '../src/analytics/officialFares';
import type { Fare, ImportedTrip, TripEvent } from '../src/db/types';

const T0 = Date.UTC(2030, 0, 7, 1, 0); // 虛構日期
const ev = (id: string, ts: number): TripEvent => ({
  id, shiftId: 's', type: 'dropoff', ts, lat: null, lon: null, accuracy: null, source: 'button', updatedAt: ts,
});
const trip = (id: string, dropoffTs: number, fare: number): ImportedTrip => ({
  id, source: 'uber_zip', externalId: null, dedupeKey: id, requestTs: dropoffTs - 20 * 60_000, pickupTs: null,
  dropoffTs, durationSec: null, distanceKm: null, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
  pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null, fare, surge: null,
  product: null, raw: {}, updatedAt: 0,
});

describe('withOfficialFares', () => {
  it('fills missing fares from the closest official dropoff within 3 minutes', () => {
    const events = [ev('a', T0), ev('b', T0 + 30 * 60_000), ev('c', T0 + 90 * 60_000)];
    const trips = [trip('x', T0 + 60_000, 111), trip('y', T0 + 31 * 60_000, 222), trip('z', T0 + 100 * 60_000, 333)];
    const m = withOfficialFares(events, new Map(), trips);
    expect(m.get('a')?.fare).toBe(111);
    expect(m.get('b')?.fare).toBe(222);
    expect(m.has('c')).toBe(false); // 差 10 分鐘，不算同一趟
  });

  it('keeps fares the driver typed and replaces pending ones', () => {
    const events = [ev('a', T0), ev('b', T0 + 30 * 60_000)];
    const fares = new Map<string, Fare>([
      ['a', { id: 'a', fare: 150, surge: null, tip: 20, note: '', pending: false, updatedAt: 1 }],
      ['b', { id: 'b', fare: null, surge: null, tip: null, note: '', pending: true, updatedAt: 1 }],
    ]);
    const m = withOfficialFares(events, fares, [trip('x', T0, 111), trip('y', T0 + 30 * 60_000, 222)]);
    expect(m.get('a')).toMatchObject({ fare: 150, tip: 20 });
    expect(m.get('b')).toMatchObject({ fare: 222, pending: false });
  });

  it('gives each official trip to only one dropoff', () => {
    const m = withOfficialFares([ev('a', T0), ev('b', T0 + 60_000)], new Map(), [trip('x', T0 + 50_000, 111)]);
    expect(m.get('b')?.fare).toBe(111);
    expect(m.has('a')).toBe(false);
  });
});

import { avgRecentFare } from '../src/analytics/officialFares';
import { shiftSummary } from '../src/domain/state';

describe('記錄頁的估計', () => {
  it('avgRecentFare 用最近 60 天，不足 20 趟時改用全部', () => {
    const now = T0 + 100 * 86_400_000;
    const recent = Array.from({ length: 20 }, (_, i) => trip(`r${i}`, now - i * 3_600_000, 200));
    const old = [trip('o', T0, 500)];
    expect(avgRecentFare([...recent, ...old], now)).toBe(200);
    expect(avgRecentFare([recent[0]!, ...old], now)).toBe(350);
    expect(avgRecentFare([], now)).toBeNull();
  });

  it('shiftSummary 算出還沒有車資的趟數', () => {
    const on: TripEvent = { ...ev('on', T0 - 3_600_000), type: 'online' };
    const fares = new Map<string, Fare>([['a', { id: 'a', fare: 150, surge: null, tip: null, note: '', pending: false, updatedAt: 1 }]]);
    const s = shiftSummary([on, ev('a', T0), ev('b', T0 + 60_000)], fares, 's', T0 + 3_600_000);
    expect([s.trips, s.earnings, s.unpriced]).toEqual([2, 150, 1]);
  });
});

import { estimateUnpriced, fitFareModel } from '../src/analytics/officialFares';

describe('依載客時間估車資', () => {
  const mk = (i: number, min: number, fare: number): ImportedTrip => ({
    ...trip(`m${i}`, T0 + i * 3_600_000, fare), durationSec: min * 60, requestTs: T0 + i * 3_600_000,
  });
  it('擬合出每分鐘多少錢，短程估得少、長程估得多', () => {
    const data = Array.from({ length: 40 }, (_, i) => mk(i, 5 + (i % 20), 50 + 12 * (5 + (i % 20))));
    const m = fitFareModel(data, T0 + 50 * 3_600_000)!;
    expect(m.b).toBeCloseTo(12);
    expect(m.a).toBeCloseTo(50);
    const pick = (id: string, ts: number): TripEvent => ({ ...ev(id, ts), type: 'pickup' });
    const events = [pick('p1', T0), ev('d1', T0 + 5 * 60_000), pick('p2', T0 + 10 * 60_000), ev('d2', T0 + 40 * 60_000)];
    expect(estimateUnpriced(events, new Map(), 's', m, 200)).toBeCloseTo(110 + 410);
    expect(fitFareModel(data.slice(0, 5), T0)).toBeNull();
    expect(estimateUnpriced([ev('x', T0)], new Map(), 's', null, 200)).toBe(200);
  });
});

import { driverEarnings, regionAt, trackKm } from '../src/analytics/uberRates';

describe('Uber 費率公式', () => {
  it('桃園與北北基標準車', () => {
    // 桃園：59 + 25×5 + 1.7×12 = 204.4 → ×0.75 = 153.3 → 153
    expect(driverEarnings('taoyuan', 'standard', 5, 12)).toBe(153);
    // 北北基：48 + 25×5 + 3.4×12 = 213.8 → 160.35 → 160
    expect(driverEarnings('taipei', 'standard', 5, 12)).toBe(160);
    // 最低車資 90 → 67.5 → .5 往下 = 67
    expect(driverEarnings('taoyuan', 'standard', 0.5, 2)).toBe(67);
    expect(driverEarnings('taoyuan', 'black', 5, 12)).toBeGreaterThan(driverEarnings('taoyuan', 'comfort', 5, 12));
  });
  it('依位置判斷地區', () => {
    expect(regionAt(24.99, 121.31)).toBe('taoyuan'); // 桃園市區
    expect(regionAt(25.04, 121.52)).toBe('taipei'); // 台北車站
    expect(regionAt(25.13, 121.74)).toBe('taipei'); // 基隆
    expect(regionAt(25.06, 121.22)).toBe('taoyuan'); // 大園附近
  });
  it('軌跡里程', () => {
    const pts = [0, 1, 2].map((i) => ({ ts: i * 60_000, lat: 25 + i * 0.009, lon: 121.3 }));
    expect(trackKm(pts, 0, 120_000)).toBeCloseTo(2 * 1.05, 1);
    expect(trackKm(pts, 0, 10)).toBeNull();
  });
  it('有軌跡時用費率公式、車種看接單事件', () => {
    const acc: TripEvent = { ...ev('a', T0 - 600_000), type: 'accept', product: 'black', lat: 24.99, lon: 121.31 };
    const pick: TripEvent = { ...ev('p', T0), type: 'pickup', lat: 24.99, lon: 121.31 };
    const drop = ev('d', T0 + 12 * 60_000);
    const pts = Array.from({ length: 13 }, (_, i) => ({ ts: T0 + i * 60_000, lat: 24.99 + i * 0.00366, lon: 121.31 }));
    const km = trackKm(pts, T0, T0 + 12 * 60_000)!;
    expect(estimateUnpriced([acc, pick, drop], new Map(), 's', null, 200, pts)).toBe(driverEarnings('taoyuan', 'black', km, 12));
  });
});
