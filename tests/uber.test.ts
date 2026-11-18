// Uber 官方資料解析（用虛構的資料列，不含真實行程）
import { describe, expect, it } from 'vitest';
import type { ImportedTrip } from '../src/db/types';
import {
  UberFormatError,
  attachPaths,
  checkAnalyticsHeader,
  driverEarnings,
  idleFromStates,
  matchVideoTrips,
  parseUtc,
  pointFromAnalytics,
  roundHalfDown,
  summarize,
  tripFromRow,
} from '../src/import/uber';
import { migrateBackup, migrateTripV1 } from '../src/domain/migrate';

const tripRow = (o: Record<string, string> = {}) => ({
  city_name: 'Testville',
  status: 'completed',
  request_timestamp_utc: '2026-03-02 01:05:10',
  begintrip_timestamp_utc: '2026-03-02 01:11:00',
  dropoff_timestamp_utc: '2026-03-02 01:21:00',
  trip_duration_seconds: '600',
  trip_distance_miles: '2.0',
  original_fare_local: '200.0',
  booking_fee_local: '8.0',
  service_fee: '0.25',
  surge_fare_local: '30.0',
  toll_amount_local: '0.0',
  product_type_name: 'UberX',
  ...o,
});

describe('官方行程', () => {
  it('UTC 時間', () => {
    expect(parseUtc('2026-03-02 01:05:10')).toBe(Date.UTC(2026, 2, 2, 1, 5, 10));
    expect(parseUtc('2021-12-22T01:26:54.000Z')).toBe(Date.UTC(2021, 11, 22, 1, 26, 54));
    expect(parseUtc('')).toBeNull();
  });

  it('司機實收公式（和卡片金額一致的算法）', () => {
    expect(driverEarnings(tripRow())).toBe(144); // (200-8)*0.75
    expect(driverEarnings(tripRow({ original_fare_local: '421', booking_fee_local: '10' }))).toBe(308); // 308.25
    expect(driverEarnings(tripRow({ original_fare_local: '420', booking_fee_local: '10' }))).toBe(307); // 307.5 → 307
    expect(driverEarnings(tripRow({ toll_amount_local: '40' }))).toBe(184);
    expect(roundHalfDown(2.5)).toBe(2);
    expect(roundHalfDown(2.51)).toBe(3);
  });

  it('只匯入完成的行程；加成存原始金額；英里換公里', () => {
    const t = tripFromRow(tripRow(), 1)!;
    expect(t.source).toBe('uber_zip');
    expect(t.requestTs).toBe(Date.UTC(2026, 2, 2, 1, 5, 10));
    expect(t.dropoffTs! - t.pickupTs!).toBe(600_000);
    expect([t.fare, t.surge, t.distanceKm, t.durationSec]).toEqual([144, 30, 3.22, 600]);
    expect(t.dedupeKey).toBe(`uber|${t.requestTs}`);
    expect(tripFromRow(tripRow({ status: 'requester_canceled' }), 1)).toBeNull();
  });
});

describe('空車時段', () => {
  const s = (state: string, b: string, e: string) => ({ earner_state: state, begin_timestamp_utc: b, end_timestamp_utc: e });
  const rows = [
    s('open', '2026-11-18T00:00:00.000Z', '2026-11-18T00:10:00.000Z'),
    s('enroute', '2026-11-18T00:10:00.000Z', '2026-11-18T00:15:00.000Z'),
    s('ontrip', '2026-11-18T00:15:00.000Z', '2026-11-18T00:30:00.000Z'),
    s('open', '2026-11-18T00:30:00.000Z', '2026-11-18T01:00:00.000Z'),
    s('offline', '2026-11-18T01:00:00.000Z', '2026-11-18T05:00:00.000Z'),
  ];
  it('open 段：接到單或下線（截尾）', () => {
    const idle = idleFromStates(rows, 0);
    expect(idle.map((p) => [(p.end - p.start) / 60_000, p.endedWithOrder])).toEqual([
      [10, true],
      [30, false],
    ]);
  });

  it('App 分析定位放進空車時段（只用上線時的點、稀疏化）', () => {
    const idle = idleFromStates(rows, 0);
    const T = Date.UTC(2026, 10, 18, 0, 0);
    const pt = (sec: number, dLat: number, online = 'true') => ({
      time: new Date(T + sec * 1000).toISOString().replace('T', ' ').slice(0, 19),
      'msg.location.lat': String(25 + dLat),
      'msg.location.lng': '121.5',
      'msg.driver_app.driver_online': online,
      'msg.driver_app.device.imei_number': 'SHOULD-NOT-BE-READ',
    });
    const raw = [pt(10, 0), pt(20, 0.01), pt(70, 0.0101), pt(130, 0.02), pt(200, 0.03, 'false'), pt(2000, 0.05)];
    const points = raw.map(pointFromAnalytics).filter((p) => p != null);
    expect(points).toHaveLength(5);
    expect(Object.keys(points[0]!)).toEqual(['ts', 'lat', 'lon']);
    expect(attachPaths(idle, points)).toBe(2);
    expect(idle[0]!.path!.map((p) => p[0] - T)).toEqual([10_000, 70_000, 130_000]); // 20 秒那點離上一點不到 30 秒，略過
    expect(idle[1]!.path).toHaveLength(1);
    const sum = summarize([tripFromRow(tripRow(), 0)!], idle, points.length);
    expect([sum.trips, sum.earnings, sum.idlePeriods, sum.withPath]).toEqual([1, 144, 2, 2]);
    expect(sum.idleHours).toBeCloseTo(40 / 60);
  });

  it('缺欄位時給看得懂的錯誤', () => {
    expect(() => checkAnalyticsHeader(['time'])).toThrow(UberFormatError);
    expect(() => checkAnalyticsHeader(['time', 'msg.location.lat', 'msg.location.lng', 'msg.driver_app.driver_online'])).not.toThrow();
  });
});

describe('影片行程和官方行程對上', () => {
  const official = tripFromRow(tripRow(), 0)!;
  const video: ImportedTrip = {
    ...official,
    id: 'vid_1',
    source: 'video',
    dedupeKey: 'v1',
    requestTs: Date.UTC(2026, 2, 2, 1, 5), // 卡片只到分
    pickupTs: null,
    dropoffTs: null,
    durationSec: 600,
    pickupAddress: '虛構路',
    raw: {},
  };
  it('同一分鐘接單、時長相同就補上準確時間', () => {
    const [m] = matchVideoTrips([video], [official], 9);
    expect(m!.pickupTs).toBe(official.pickupTs);
    expect(m!.dropoffTs).toBe(official.dropoffTs);
    expect(m!.pickupAddress).toBe('虛構路');
    expect(m!.updatedAt).toBe(9);
    expect(matchVideoTrips([{ ...video, durationSec: 500 }], [official], 9)).toEqual([]);
    expect(matchVideoTrips([m!], [official], 9)).toEqual([]); // 已經對過的不再處理
  });
});

describe('資料格式升級 v1 → v2', () => {
  it('影片行程的卡片時間從 pickupTs 搬到 requestTs；官方行程不動', () => {
    const v1 = { ...tripFromRow(tripRow(), 0)!, source: 'video' as const, requestTs: null, pickupTs: 123, dropoffTs: 456 };
    expect(migrateTripV1(v1)).toMatchObject({ requestTs: 123, pickupTs: null, dropoffTs: null });
    const off = tripFromRow(tripRow(), 0)!;
    expect(migrateTripV1(off)).toBe(off);
  });
  it('舊備份檔補上 importedIdle', () => {
    const b = migrateBackup({
      app: 'db-radar', schemaVersion: 1, exportedAt: 0, events: [], fares: [], trackPoints: [],
      importedTrips: [], importedIdle: undefined as never, settings: {} as never,
    });
    expect(b.importedIdle).toEqual([]);
  });
});

import JSZip from 'jszip';
import { parseUberZip } from '../src/import/uberZip';

describe('讀 zip（虛構檔案）', () => {
  it('只讀三個檔案；App 分析中間有含逗號的引號欄位也能正確取出經緯度', async () => {
    const zip = new JSZip();
    zip.file('Uber Data/Driver/driver_lifetime_trips-0.csv',
      'status,request_timestamp_utc,begintrip_timestamp_utc,dropoff_timestamp_utc,trip_duration_seconds,original_fare_local,booking_fee_local,service_fee\n' +
      'completed,2026-03-02 01:05:10,2026-03-02 01:11:00,2026-03-02 01:21:00,600,200,8,0.25\n' +
      'completed,2026-03-02 01:05:10,2026-03-02 01:11:00,2026-03-02 01:21:00,600,200,8,0.25\n' +
      'requester_canceled,2026-03-02 02:00:00,,,,0,0,0.25\n');
    zip.file('Uber Data/Driver/driver_online_offline-0.csv',
      'earner_state,city_id,begin_timestamp_utc,end_timestamp_utc\n' +
      'open,1,2026-03-02T00:55:00.000Z,2026-03-02T01:05:10.000Z\n' +
      'enroute,1,2026-03-02T01:05:10.000Z,2026-03-02T01:11:00.000Z\n');
    zip.file('Uber Data/Driver/driver_app_analytics-0.csv',
      'datestr,time,gps_time,msg.driver_app.driver_online,msg.driver_app.device.imei_number,msg.driver_app.device.cpu_abi,msg.location.lat,msg.location.lng,msg.location.speed,msg.app_name\r\n' +
      '2026-03-02,2026-03-02 00:56:00,x,true,SECRET,", arm64-v8a",25.01,121.31,0.0,driver_app\r\n' +
      '2026-03-02,2026-03-02 01:00:00,x,true,SECRET,"a,b,c",25.02,121.32,0.0,driver_app\r\n' +
      '2026-03-02,2026-03-02 01:01:00,x,false,SECRET,"",25.03,121.33,0.0,driver_app\r\n');
    zip.file('Uber Data/Account and Profile/payment_methods-0.csv', 'card\n1234\n');
    const r = await parseUberZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]!.fare).toBe(144);
    expect(r.idle).toHaveLength(1);
    expect(r.idle[0]!.endedWithOrder).toBe(true);
    expect(r.points).toBe(2);
    expect(r.idle[0]!.path!.map((p) => [p[1], p[2]])).toEqual([[25.01, 121.31], [25.02, 121.32]]);
    expect(r.skipped).toEqual(['Uber Data/Account and Profile/payment_methods-0.csv']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});
