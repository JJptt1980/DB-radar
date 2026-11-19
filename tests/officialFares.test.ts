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
