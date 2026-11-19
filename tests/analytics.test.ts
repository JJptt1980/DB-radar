import { describe, expect, it } from 'vitest';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { DEFAULT_SETTINGS, type Fare, type ImportedTrip, type TrackPoint, type TripEvent } from '../src/db/types';
import { adjacentSlots, dayType, slotLabel, slotOf } from '../src/analytics/slots';
import { buildStats } from '../src/analytics/stats';
import { estimate, recommend, viewAt, M_HOURS } from '../src/analytics/model';
import { ZONES, generateFake, zoneCenter } from '../src/dev/fake';
import { distanceM } from '../src/domain/geo';

const S = DEFAULT_SETTINGS;
const H = 3_600_000;
const MIN = 60_000;
// 2026-11-20 是週五；台北 22:00 = UTC 14:00
const FRI_22 = Date.UTC(2026, 10, 20, 14, 0);
const C = { lat: 25.0478, lon: 121.517 };

function ev(id: string, type: TripEvent['type'], ts: number, p: { lat: number; lon: number } | null, shiftId = 's'): TripEvent {
  return { id, shiftId, type, ts, lat: p?.lat ?? null, lon: p?.lon ?? null, accuracy: p ? 10 : null, source: 'button', updatedAt: ts };
}

describe('槽位', () => {
  it('日型與國定假日', () => {
    expect(dayType(FRI_22, new Set())).toBe('fri');
    expect(dayType(FRI_22, new Set(['2026-11-20']))).toBe('holiday');
    expect(dayType(FRI_22 + 3 * H, new Set())).toBe('sat'); // 台北週六 01:00
    expect(dayType(Date.UTC(2026, 10, 18, 4), new Set())).toBe('weekday');
  });
  it('槽位、相鄰槽位與顯示文字', () => {
    expect(slotOf(FRI_22, new Set())).toBe('fri:22');
    expect(adjacentSlots('fri:0')).toEqual(['fri:23', 'fri:1']);
    expect(slotLabel('fri:22')).toBe('週五 22 點');
  });
});

describe('buildStats', () => {
  const A = { lat: 25.05, lon: 121.52 };
  const B = { lat: 25.07, lon: 121.55 }; // 另一個格子
  const cellA = latLngToCell(A.lat, A.lon, 8);
  const cellB = latLngToCell(B.lat, B.lon, 8);
  const t0 = FRI_22 - 30 * MIN; // 週五 21:30

  const base = [
    ev('on', 'online', t0, A),
    ev('acc', 'accept', t0 + 60 * MIN, A), // 空車 60 分，跨 22 點
    ev('pk', 'pickup', t0 + 70 * MIN, B),
    ev('dr', 'dropoff', t0 + 90 * MIN, B),
    ev('dec', 'offer_declined', t0 + 100 * MIN, B),
    ev('off', 'offline', t0 + 120 * MIN, B), // 下客後空車 30 分沒等到單（截尾）
  ];
  const fares = new Map<string, Fare>([['dr', { id: 'dr', fare: 300, surge: 50, tip: 20, note: '', pending: false, updatedAt: 0 }]]);

  it('空車時數依整點拆到各自的槽位；截尾時間計入分母', () => {
    const st = buildStats({ events: base, fares, tracks: [], imported: [], settings: S });
    expect(st.cells.get('fri:21')!.get(cellA)!.idleHours).toBeCloseTo(0.5);
    expect(st.cells.get('fri:22')!.get(cellA)!.idleHours).toBeCloseTo(0.5);
    expect(st.cells.get('fri:23')!.get(cellB)!.idleHours).toBeCloseTo(0.5); // 23:00～23:30
    expect(st.tripCount).toBe(1);
  });

  it('接單、拒單、實收（加成不重複加）、耗時', () => {
    const st = buildStats({ events: base, fares, tracks: [], imported: [], settings: S });
    const a = st.cells.get('fri:22')!.get(cellA)!;
    expect(a.orders).toBe(1);
    expect(a.sumNetFare).toBe(320);
    expect(a.sumOrderMinutes).toBe(30);
    expect(st.cells.get('fri:23')!.get(cellB)!.declined).toBe(1);
    const noInclude = buildStats({ events: base, fares, tracks: [], imported: [], settings: { ...S, fareIncludesSurge: false } });
    expect(noInclude.cells.get('fri:22')!.get(cellA)!.sumNetFare).toBe(370);
  });

  it('待補車資的單不算進實收，但算進單數；取消單實收 0', () => {
    const pend = new Map<string, Fare>([['dr', { ...fares.get('dr')!, pending: true, fare: null }]]);
    const st = buildStats({ events: base, fares: pend, tracks: [], imported: [], settings: S });
    const a = st.cells.get('fri:22')!.get(cellA)!;
    expect([a.orders, a.fareOrders]).toEqual([1, 0]);
    const cancelled = [ev('on', 'online', t0, A), ev('acc', 'accept', t0 + 60 * MIN, A), ev('cx', 'cancel', t0 + 65 * MIN, A)];
    const c = buildStats({ events: cancelled, fares: new Map(), tracks: [], imported: [], settings: S }).cells.get('fri:22')!.get(cellA)!;
    expect([c.orders, c.fareOrders, c.sumNetFare, c.sumOrderMinutes]).toEqual([1, 1, 0, 5]);
  });

  it('有軌跡時空車時數跟著軌跡走；精度太差的點不用', () => {
    const events = [ev('on', 'online', t0, A), ev('acc', 'accept', t0 + 60 * MIN, B)];
    const tracks: TrackPoint[] = [
      { id: 'p1', shiftId: 's', ts: t0 + 20 * MIN, lat: A.lat, lon: A.lon, accuracy: 10, speed: null, heading: null },
      { id: 'p2', shiftId: 's', ts: t0 + 40 * MIN, lat: B.lat, lon: B.lon, accuracy: 10, speed: null, heading: null },
      { id: 'bad', shiftId: 's', ts: t0 + 30 * MIN, lat: 0, lon: 0, accuracy: 500, speed: null, heading: null },
    ];
    const st = buildStats({ events, fares: new Map(), tracks, imported: [], settings: S });
    const hours = (slot: string, cell: string) => st.cells.get(slot as never)?.get(cell)?.idleHours ?? 0;
    // A：21:30～21:50 + 21:50～22:00 的一半…；總和要等於 1 小時
    const total = ['fri:21', 'fri:22'].reduce((s, sl) => s + hours(sl, cellA) + hours(sl, cellB), 0);
    expect(total).toBeCloseTo(1);
    expect(hours('fri:21', cellA) + hours('fri:22', cellA)).toBeCloseTo(0.5);
  });

  it('影片空檔：同一天、空檔 ≤ gapBreakMin、精度夠的才算；已配對的不算', () => {
    const vid = (id: string, pickMin: number, durMin: number, extra: Partial<ImportedTrip> = {}): ImportedTrip => ({
      id, source: 'video', externalId: null, dedupeKey: id,
      requestTs: t0 + pickMin * MIN, pickupTs: null, dropoffTs: null, durationSec: durMin * 60, distanceKm: 3,
      pickupLat: A.lat, pickupLon: A.lon, dropoffLat: B.lat, dropoffLon: B.lon,
      pickupAddress: '', dropoffAddress: '', pickupPrecision: 'lane', dropoffPrecision: 'lane',
      fare: 200, surge: 0, product: null, matchedDropoffEventId: null, raw: {}, updatedAt: 0, ...extra,
    });
    const imported = [vid('v1', 0, 10), vid('v2', 16, 10), vid('v3', 100, 10), vid('v4', 115, 10, { matchedDropoffEventId: 'x' })];
    const st = buildStats({ events: [], fares: new Map(), tracks: [], imported, settings: S });
    const v = st.video.get('fri:21')!.get(cellB)!;
    expect(v.orders).toBe(1); // v1→v2 空檔 6 分；v2→v3 空檔 74 分 > 45 不算；v4 已配對
    expect(v.idleHours).toBeCloseTo(0.1);
  });
});

describe('平滑與推薦', () => {
  it('資料少時往先驗收縮，資料多時接近自己的值', () => {
    const cell = latLngToCell(C.lat, C.lon, 8);
    const mk = (idle: number, orders: number) => ({
      res: 8,
      cells: new Map([['fri:22' as const, new Map([[cell, { idleHours: idle, orders, declined: 0, sumNetFare: orders * 200, fareOrders: orders, sumOrderMinutes: orders * 20, durOrders: orders }]])]]),
      video: new Map(),
      official: new Map(),
      tripCount: 100,
      firstTs: 0,
    });
    const few = estimate(viewAt(mk(0.5, 3), 'fri:22'), cell, S);
    const many = estimate(viewAt(mk(50, 300), 'fri:22'), cell, S);
    // 只有這一格有資料：先驗 = 全城 = 自己；混合權重 0.6 → idle 0.3h
    expect(few.shrink).toBeCloseTo(M_HOURS / (0.3 + M_HOURS));
    expect(few.confidence).toBe('low');
    expect(many.confidence).toBe('high');
    expect(many.lambda).toBeCloseTo(6, 0);
    expect(many.W).toBeCloseTo(10, 0);
  });

  it('假資料：週五 22 點從市中心出發，雷達指向夜生活區', () => {
    const fake = generateFake({ center: C, endDay: Date.UTC(2026, 10, 19, 16), days: 60, seed: 7 });
    expect(fake.events.filter((e) => e.type === 'dropoff').length).toBeGreaterThan(300);
    const declined = fake.events.filter((e) => e.type === 'offer_declined').length;
    const offers = declined + fake.events.filter((e) => e.type === 'accept').length;
    expect(declined / offers).toBeGreaterThan(0.12);
    expect(declined / offers).toBeLessThan(0.28);

    const fares = new Map(fake.fares.map((f) => [f.id, f]));
    const t = performance.now();
    const st = buildStats({ events: fake.events, fares, tracks: fake.tracks, imported: [], settings: S });
    const rec = recommend(st, 'fri:22', C, S);
    const ms = performance.now() - t;
    const night = zoneCenter(C, ZONES.find((z) => z.name === '夜生活區')!);
    const [blat, blon] = cellToLatLng(rec.best.cell);
    expect(rec.enough).toBe(true);
    expect(rec.stay).toBe(false);
    expect(distanceM(night, { lat: blat, lon: blon })).toBeLessThan(1200);
    // 換成平日早上 8 點：應該指向車站一帶
    const morning = recommend(st, 'weekday:8', C, S);
    const station = zoneCenter(C, ZONES.find((z) => z.name === '車站')!);
    const near = gridDisk(latLngToCell(station.lat, station.lon, 8), 2);
    expect(near.includes(morning.best.cell)).toBe(true);
    expect(ms).toBeLessThan(3000);
  });
});

import { bestCells, bestSlots, declineStats, weekKey, weekly } from '../src/analytics/summary';

describe('統計頁', () => {
  const fake = generateFake({ center: C, endDay: Date.UTC(2026, 10, 19, 16), days: 60, seed: 7 });
  const fares = new Map(fake.fares.map((f) => [f.id, f]));
  const st = buildStats({ events: fake.events, fares, tracks: fake.tracks, imported: [], settings: S });

  it('最佳時段：前幾名包含週五或週六晚上', () => {
    const top = bestSlots(st, S, 5).map((r) => r.slot);
    expect(top.some((s) => /^(fri|sat):(21|22|23)$/.test(s))).toBe(true);
  });

  it('最佳格子：第一名在夜生活區附近', () => {
    const top = bestCells(st, S, 3);
    const night = zoneCenter(C, ZONES.find((z) => z.name === '夜生活區')!);
    expect(top.length).toBeGreaterThan(0);
    expect(Math.min(...top.map((c) => distanceM(night, c.center)))).toBeLessThan(1200);
  });

  it('週次以週一為界（台北時間）', () => {
    expect(weekKey(FRI_22)).toBe('2026-11-16');
    expect(weekKey(Date.UTC(2026, 10, 15, 17))).toBe('2026-11-16'); // 台北週一 01:00
    expect(weekKey(Date.UTC(2026, 10, 15, 15))).toBe('2026-11-09'); // 台北週日 23:00
  });

  it('每週時薪 = 實收 ÷ 上線時數', () => {
    const w = weekly(fake.events, fares, S, Date.UTC(2026, 10, 19, 16));
    expect(w.length).toBeGreaterThan(4);
    for (const p of w) {
      expect(p.trips).toBeGreaterThan(0);
      expect(p.hourly!).toBeCloseTo(p.earnings / p.onlineHours);
    }
  });

  it('挑單分析：拒單理由與拒單後的等待', () => {
    const d = declineStats(fake.events);
    expect(d.total).toBeGreaterThan(50);
    expect(d.byReason.too_far + d.byReason.low_fare + d.byReason.wrong_direction + d.byReason.none).toBe(d.total);
    expect(d.afterDeclineWaitMin).not.toBeNull();
    expect(d.avgWaitMin).not.toBeNull();
  });
});

import { heatCells, heatColor, scaleRange, viewFor } from '../src/analytics/heat';

describe('地圖熱力圖', () => {
  const fake = generateFake({ center: C, endDay: Date.UTC(2026, 10, 19, 16), days: 60, seed: 7 });
  const st = buildStats({ events: fake.events, fares: new Map(fake.fares.map((f) => [f.id, f])), tracks: fake.tracks, imported: [], settings: S });

  it('週五 22 點最熱的六角形在夜生活區', () => {
    const cells = heatCells(st, 'fri', 22, S);
    const night = zoneCenter(C, ZONES.find((z) => z.name === '夜生活區')!);
    const [lat, lon] = cellToLatLng(cells[0]!.cell);
    expect(distanceM(night, { lat, lon })).toBeLessThan(1200);
    expect(cells[0]!.boundary.length).toBe(6);
  });

  it('「全部」把所有槽位加總；整天比單一小時有更多格子', () => {
    const all = viewFor(st, 'all', 'all');
    let idle = 0;
    for (const m of st.cells.values()) for (const a of m.values()) idle += a.idleHours;
    expect(all.city.idleHours).toBeCloseTo(idle);
    expect(heatCells(st, 'fri', 'all', S).length).toBeGreaterThanOrEqual(heatCells(st, 'fri', 22, S).length);
  });

  it('色階與範圍', () => {
    expect(heatColor(0)).toBe('rgb(30, 90, 110)');
    expect(heatColor(1)).toBe('rgb(235, 60, 50)');
    expect(heatColor(2)).toBe(heatColor(1));
    const [lo, hi] = scaleRange([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    expect(lo).toBe(2);
    expect(hi).toBe(9);
    expect(scaleRange([])).toEqual([0, 1]);
    const [a, b] = scaleRange([5, 5, 5]);
    expect(b).toBeGreaterThan(a);
  });
});


import type { ImportedIdle } from '../src/db/types';

describe('Uber 官方資料進分析', () => {
  const A = { lat: 25.05, lon: 121.52 };
  const cellA = latLngToCell(A.lat, A.lon, 8);
  const t0 = FRI_22; // 週五 22:00
  const idle = (id: string, startMin: number, endMin: number, withPath: boolean, endedWithOrder = true): ImportedIdle => ({
    id, source: 'uber_zip', start: t0 + startMin * MIN, end: t0 + endMin * MIN, endedWithOrder,
    path: withPath ? [[t0 + (startMin + 1) * MIN, A.lat, A.lon]] : null, updatedAt: 0,
  });
  const trip = (startMin: number, fare: number): ImportedTrip => ({
    id: `t${startMin}`, source: 'uber_zip', externalId: null, dedupeKey: `t${startMin}`,
    requestTs: t0 + startMin * MIN, pickupTs: t0 + (startMin + 5) * MIN, dropoffTs: t0 + (startMin + 25) * MIN,
    durationSec: 1200, distanceKm: 5, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
    pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null,
    fare, surge: 0, product: null, matchedDropoffEventId: null, raw: {}, updatedAt: 0,
  });

  it('有定位的空車時段算進格子（權重 1），接到的單帶上實收與耗時', () => {
    const st = buildStats({ events: [], fares: new Map(), tracks: [], imported: [trip(30, 300)], idle: [idle('a', 0, 30, true)], settings: S });
    const a = st.cells.get('fri:22')!.get(cellA)!;
    expect(a.idleHours).toBeCloseTo(0.5);
    expect([a.orders, a.sumNetFare, a.sumOrderMinutes]).toEqual([1, 300, 25]);
    expect(st.tripCount).toBe(1);
  });

  it('沒有定位的只進全城層，分析時乘上 importWeight', () => {
    const st = buildStats({ events: [], fares: new Map(), tracks: [], imported: [trip(30, 300)], idle: [idle('a', 0, 30, false)], settings: S });
    expect(st.cells.size).toBe(0);
    const o = st.official.get('fri:22')!;
    expect([o.idleHours, o.orders, o.sumNetFare, o.fareOrders]).toEqual([0.5, 1, 300, 1]);
    expect(st.tripCount).toBe(0);
    const v = viewAt(st, 'fri:22', 0.5);
    expect(v.city.idleHours).toBeCloseTo(0.5 * 0.6 * 0.5);
  });

  it('和自己按鈕記錄重疊的官方資料不重複計算', () => {
    const own = [ev('on', 'online', t0 - 10 * MIN, A), ev('off', 'offline', t0 + 60 * MIN, A)];
    const st = buildStats({ events: own, fares: new Map(), tracks: [], imported: [trip(30, 300)], idle: [idle('a', 0, 30, true)], settings: S });
    expect(st.official.size).toBe(0);
    expect(st.cells.get('fri:22')?.get(cellA)?.orders ?? 0).toBe(0);
  });
});

describe('統計頁納入官方歷史', () => {
  it('每週：官方行程的實收與趟數；上線時數 = 空車 + 接單到下客；和自己記錄重疊的不算', () => {
    const t0 = Date.UTC(2026, 2, 2, 1, 0); // 台北週一 09:00
    const trip = (min: number, fare: number): ImportedTrip => ({
      id: `o${min}`, source: 'uber_zip', externalId: null, dedupeKey: `o${min}`,
      requestTs: t0 + min * MIN, pickupTs: t0 + (min + 5) * MIN, dropoffTs: t0 + (min + 30) * MIN,
      durationSec: 1500, distanceKm: 5, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
      pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null,
      fare, surge: 0, product: null, matchedDropoffEventId: null, raw: {}, updatedAt: 0,
    });
    const idle: ImportedIdle = { id: 'i', source: 'uber_zip', start: t0 - 30 * MIN, end: t0, endedWithOrder: true, path: null, updatedAt: 0 };
    const [w] = weekly([], new Map(), S, t0 + 10 * H, 8, { trips: [trip(0, 300)], idle: [idle] });
    expect(w!.key).toBe('2026-03-02');
    expect([w!.trips, w!.earnings]).toEqual([1, 300]);
    expect(w!.onlineHours).toBeCloseTo(1); // 30 分空車 + 30 分接單到下客
    expect(w!.hourly).toBeCloseTo(300);
    const own = [ev('on', 'online', t0 - 60 * MIN, null), ev('off', 'offline', t0 + 60 * MIN, null)];
    const [w2] = weekly(own, new Map(), S, t0 + 10 * H, 8, { trips: [trip(0, 300)], idle: [idle] });
    expect([w2!.trips, w2!.earnings]).toEqual([0, 0]);
    expect(w2!.onlineHours).toBeCloseTo(2);
  });

  it('每週：趟獎與服務費折扣算進實收與時薪，其他獎勵不算', () => {
    const t0 = Date.UTC(2026, 2, 2, 1, 0); // 台北週一 09:00
    const idle: ImportedIdle = { id: 'i', source: 'uber_zip', start: t0, end: t0 + H, endedWithOrder: false, path: null, updatedAt: 0 };
    const b = (id: string, amount: number, kind: 'quest' | 'fee_discount' | 'other') =>
      ({ id, source: 'uber_zip' as const, ts: t0 + 2 * H, amount, kind, label: '', updatedAt: 0 });
    const [w] = weekly([], new Map(), S, t0 + 10 * H, 8, {
      trips: [], idle: [idle], bonus: [b('q', 100, 'quest'), b('f', 20, 'fee_discount'), b('o', 500, 'other')],
    });
    expect([w!.bonus, w!.earnings, w!.hourly]).toEqual([120, 120, 120]);
  });
});

import { halfKey, periods, yearKey } from '../src/analytics/summary';

describe('收入期間', () => {
  it('半年與年的分組鍵（台北時間）', () => {
    expect(halfKey(Date.UTC(2026, 5, 30, 15))).toBe('2026 上半年'); // 台北 6/30 23:00
    expect(halfKey(Date.UTC(2026, 5, 30, 17))).toBe('2026 下半年'); // 台北 7/1 01:00
    expect(yearKey(Date.UTC(2025, 11, 31, 17))).toBe('2026 年');
  });
  it('依期間加總官方行程，新到舊', () => {
    const t = (id: string, ts: number, fare: number): ImportedTrip => ({
      id, source: 'uber_zip', externalId: null, dedupeKey: id, requestTs: ts, pickupTs: ts, dropoffTs: ts + 3_600_000,
      durationSec: 3600, distanceKm: 1, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
      pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null,
      fare, surge: 0, product: null, matchedDropoffEventId: null, raw: {}, updatedAt: 0,
    });
    const trips = [t('a', Date.UTC(2026, 1, 1, 4), 100), t('b', Date.UTC(2026, 8, 1, 4), 300), t('c', Date.UTC(2025, 8, 1, 4), 50)];
    const half = periods([], new Map(), S, Date.UTC(2026, 10, 1), 'half', { trips, idle: [] });
    expect(half.map((p) => [p.key, p.earnings])).toEqual([['2026 下半年', 300], ['2026 上半年', 100], ['2025 下半年', 50]]);
    const all = periods([], new Map(), S, Date.UTC(2026, 10, 1), 'all', { trips, idle: [] });
    expect([all[0]!.earnings, all[0]!.trips, all[0]!.hourly]).toEqual([450, 3, 150]);
  });
});

import { dayPart } from '../src/analytics/slots';

describe('一天六段', () => {
  it('凌晨、早上、中午、下午、晚上、半夜', () => {
    expect([2, 4, 5, 9, 10, 12, 13, 16, 17, 21, 22, 0, 1].map(dayPart)).toEqual([
      'dawn', 'dawn', 'morning', 'morning', 'noon', 'noon', 'afternoon', 'afternoon', 'evening', 'evening', 'midnight', 'midnight', 'midnight',
    ]);
  });
});

import { DRIVE_FACTOR, periodMonths } from '../src/analytics/summary';

describe('淨收入', () => {
  const trip = (id: string, ts: number, fare: number, km: number, toll = ''): ImportedTrip => ({
    id, source: 'uber_zip', externalId: null, dedupeKey: id, requestTs: ts, pickupTs: ts, dropoffTs: ts + 3_600_000,
    durationSec: 3600, distanceKm: km, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
    pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null,
    fare, surge: 0, product: null, matchedDropoffEventId: null, raw: { toll }, updatedAt: 0,
  });
  it('扣掉里程成本、過路費、固定支出', () => {
    const settings = { ...S, costPerKm: 3, monthlyFixedCost: 3000 };
    const ts = Date.UTC(2026, 2, 10, 4); // 台北 3 月
    const [m] = periods([], new Map(), settings, Date.UTC(2026, 10, 1), 'month', { trips: [trip('a', ts, 500, 10, '40')], idle: [] });
    expect(m!.key).toBe('2026-03');
    expect(m!.km).toBeCloseTo(10 * DRIVE_FACTOR);
    expect(m!.fixedCost).toBeCloseTo(3000 * (31 / 30.44));
    expect(m!.net).toBeCloseTo(500 - 14 * 3 - 40 - m!.fixedCost);
    expect(m!.netHourly).toBeCloseTo(m!.net / 1);
  });
  it('分攤月數：完整的月、半年、年；進行中的期間只算到現在', () => {
    const now = Date.UTC(2026, 9, 1) - 8 * 3_600_000; // 台北 2026-10-01 00:00
    expect(periodMonths('half', '2026 上半年', now, 0)).toBeCloseTo(181 / 30.44);
    expect(periodMonths('year', '2026 年', now, 0)).toBeCloseTo(273 / 30.44);
    expect(periodMonths('week', '2026-09-21', now, 0)).toBeCloseTo(7 / 30.44);
    expect(periodMonths('month', '2026-12', now, 0)).toBe(0);
  });
});

import { orderFilter } from '../src/analytics/stats';

describe('長單／短單偏好', () => {
  it('分界預設 300，兩個都勾或都不勾就是全部', () => {
    const f = (wantLong: boolean, wantShort: boolean) => orderFilter({ ...S, wantLong, wantShort, longFareMin: 300 });
    expect([f(true, false)(300), f(true, false)(299), f(true, false)(null)]).toEqual([true, false, true]);
    expect([f(false, true)(299), f(false, true)(300)]).toEqual([true, false]);
    expect([f(true, true)(10), f(false, false)(10)]).toEqual([true, true]);
  });
  it('只要長單時，短單不算接到單，但空車時間照算', () => {
    const t0 = Date.UTC(2026, 2, 2, 1, 0);
    const trip = (id: string, ts: number, fare: number): ImportedTrip => ({
      id, source: 'uber_zip', externalId: null, dedupeKey: id, requestTs: ts, pickupTs: ts + 300_000, dropoffTs: ts + 1_200_000,
      durationSec: 900, distanceKm: 5, pickupLat: null, pickupLon: null, dropoffLat: null, dropoffLon: null,
      pickupAddress: null, dropoffAddress: null, pickupPrecision: null, dropoffPrecision: null,
      fare, surge: 0, product: null, matchedDropoffEventId: null, raw: {}, updatedAt: 0,
    });
    const idle = (id: string, start: number, end: number): ImportedIdle => ({
      id, source: 'uber_zip', start, end, endedWithOrder: true, path: [[start, 25, 121.5], [end, 25, 121.5]], updatedAt: 0,
    });
    const H = 3_600_000;
    const input = {
      events: [], fares: new Map(), tracks: [],
      imported: [trip('a', t0, 150), trip('b', t0 + H, 450)],
      idle: [idle('i1', t0 - 600_000, t0), idle('i2', t0 + H - 600_000, t0 + H)],
    };
    const sum = (idx: ReturnType<typeof buildStats>) => {
      let orders = 0, hours = 0;
      for (const m of idx.cells.values()) for (const a of m.values()) { orders += a.orders; hours += a.idleHours; }
      return [orders, Math.round(hours * 60)];
    };
    expect(sum(buildStats({ ...input, settings: { ...S, wantLong: true, wantShort: true } }))).toEqual([2, 20]);
    expect(sum(buildStats({ ...input, settings: { ...S, wantLong: true, wantShort: false } }))).toEqual([1, 20]);
    expect(sum(buildStats({ ...input, settings: { ...S, wantLong: false, wantShort: true } }))).toEqual([1, 20]);
  });
});
