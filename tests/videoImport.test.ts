import { describe, expect, it } from 'vitest';
import type { Fare, ImportedTrip, TripEvent } from '../src/db/types';
import { parseVideoImport, planVideoImport } from '../src/import/video';

const T = Date.UTC(2026, 10, 18, 1, 43); // 台北 09:43
const MIN = 60_000;

function trip(id: string, minute: number, extra: Partial<ImportedTrip> = {}): ImportedTrip {
  return {
    id,
    source: 'video',
    externalId: null,
    dedupeKey: `2026-11-18|${id}`,
    requestTs: T + minute * MIN,
    pickupTs: null,
    dropoffTs: null,
    durationSec: 600,
    distanceKm: 3,
    pickupLat: null,
    pickupLon: null,
    dropoffLat: null,
    dropoffLon: null,
    pickupAddress: '虛構路',
    dropoffAddress: '範例街',
    pickupPrecision: 'street',
    dropoffPrecision: 'lane',
    fare: 200,
    surge: 30,
    product: '標準型優步',
    lowSupport: false,
    matchedDropoffEventId: null,
    raw: {},
    updatedAt: 0,
    ...extra,
  };
}

function ev(id: string, type: TripEvent['type'], minute: number): TripEvent {
  return { id, shiftId: 's', type, ts: T + minute * MIN, lat: null, lon: null, accuracy: null, source: 'button', updatedAt: 0 };
}

const file = (trips: ImportedTrip[]) => ({ sourceVideo: 'v.mp4', exportedAt: 0, trips });

describe('parseVideoImport', () => {
  it('只接受影片匯入檔', () => {
    expect(() => parseVideoImport({ app: 'db-radar', schemaVersion: 1, events: [] })).toThrow(/備份檔/);
    expect(() => parseVideoImport({ app: 'x' })).toThrow();
    const ok = parseVideoImport({ app: 'db-radar', kind: 'video-import', schemaVersion: 1, importedTrips: [trip('a', 0)] });
    expect(ok.trips).toHaveLength(1);
  });
});

describe('planVideoImport', () => {
  it('統計總數、加成與精度，dedupeKey 重複的略過', () => {
    const plan = planVideoImport(
      file([trip('a', 0), trip('b', 30, { lowSupport: true, surge: 0 })]),
      [trip('a', 0)],
      [],
      new Map(),
      5,
    );
    expect(plan.total).toBe(2);
    expect(plan.fareSum).toBe(400);
    expect(plan.surgeSum).toBe(30);
    expect(plan.lowSupport).toBe(1);
    expect(plan.precision).toEqual({ street: 2, lane: 2 });
    expect(plan.skipped).toBe(1);
    expect(plan.toAdd.map((t) => t.id)).toEqual(['b']);
    expect(plan.toAdd[0]!.updatedAt).toBe(5);
    expect(plan.dates).toEqual(['2026-11-18']);
  });

  it('同一個檔案匯入第二次，什麼都不新增', () => {
    const f = file([trip('a', 0), trip('b', 30)]);
    const first = planVideoImport(f, [], [], new Map(), 0);
    const second = planVideoImport(f, first.toAdd, [], new Map(), 0);
    expect(second.toAdd).toEqual([]);
    expect(second.skipped).toBe(2);
  });

  it('和 3 分鐘內的接單配對（卡片時間是接單時間），車資還在待補時建議補上', () => {
    const events = [ev('on', 'online', -20), ev('acc', 'accept', 1), ev('pk', 'pickup', 8), ev('dr', 'dropoff', 18)];
    const fares = new Map<string, Fare>([
      ['dr', { id: 'dr', fare: null, surge: null, tip: null, note: '', pending: true, updatedAt: 0 }],
    ]);
    const plan = planVideoImport(file([trip('a', 0)]), [], events, fares, 0);
    expect(plan.matched).toBe(1);
    expect(plan.toAdd[0]!.matchedDropoffEventId).toBe('dr');
    expect(plan.fareSuggestions).toEqual([{ eventId: 'dr', tripId: 'a', fare: 200, surge: 30 }]);
  });

  it('超過 3 分鐘不配對；車資已填就不建議；接單後取消的不配對', () => {
    const events = [ev('acc', 'accept', 4), ev('pk', 'pickup', 9), ev('dr', 'dropoff', 14)];
    expect(planVideoImport(file([trip('a', 0)]), [], events, new Map(), 0).matched).toBe(0);
    const fares = new Map<string, Fare>([
      ['dr', { id: 'dr', fare: 180, surge: 0, tip: null, note: '', pending: false, updatedAt: 0 }],
    ]);
    const plan = planVideoImport(file([trip('a', 2)]), [], events, fares, 0);
    expect(plan.matched).toBe(1);
    expect(plan.fareSuggestions).toEqual([]);
    const cancelled = [ev('acc', 'accept', 0), ev('cx', 'cancel', 3), ev('dr', 'dropoff', 30)];
    expect(planVideoImport(file([trip('a', 0)]), [], cancelled, new Map(), 0).matched).toBe(0);
  });

  it('舊格式（v1）的影片匯入檔：卡片時間從 pickupTs 搬到 requestTs', () => {
    const old = { ...trip('a', 0), requestTs: null, pickupTs: T, dropoffTs: T + 600_000 };
    const f = parseVideoImport({ app: 'db-radar', kind: 'video-import', schemaVersion: 1, importedTrips: [old] });
    expect([f.trips[0]!.requestTs, f.trips[0]!.pickupTs, f.trips[0]!.dropoffTs]).toEqual([T, null, null]);
  });
});
