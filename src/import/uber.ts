// Uber 官方資料（「下載你的資料」zip）的解析（SPEC 第 7 章）。純函式。
//
// 2026-11-19 拿到真實檔案後確認的格式：
// - Driver/driver_lifetime_trips-0.csv：每趟的接單、上客、下客 UTC 時間、距離（英里）、時長、狀態、車資明細。沒有地點。
// - Driver/driver_online_offline-0.csv：上線狀態的每一段（open 空車、enroute 前往接客、ontrip 載客、offline）。
// - Driver/driver_app_analytics-0.csv：最近 30 天的 App 事件，有 UTC 時間、經緯度、是否上線。
//   這個檔也有 IMEI、IP、廣告 ID 等個資，只讀時間、經緯度、上線三個欄位，其他欄位一律不讀。
// 其他檔案（帳號、付款、客服、評分、週報表上的姓名車牌…）不讀。
import type { ImportedBonus, ImportedIdle, ImportedTrip } from '../db/types';
import { distanceM } from '../domain/geo';

export type Row = Record<string, string>;

export const UBER_FILES = {
  trips: /driver_lifetime_trips[^/]*\.csv$/i,
  states: /driver_online_offline[^/]*\.csv$/i,
  analytics: /driver_app_analytics[^/]*\.csv$/i,
  bonus: /miscellaneous_payments[^/]*\.csv$/i,
};

export const BONUS_COLUMNS = ['Date Created', 'Amount', 'TYPE', 'Description'] as const;

/** 只讀這些欄位；其餘欄位（含個資）不保留 */
export const ANALYTICS_COLUMNS = ['time', 'msg.location.lat', 'msg.location.lng', 'msg.driver_app.driver_online'] as const;
const TRIP_COLUMNS = ['request_timestamp_utc', 'status'] as const;
const STATE_COLUMNS = ['earner_state', 'begin_timestamp_utc', 'end_timestamp_utc'] as const;

export class UberFormatError extends Error {}

export function requireColumns(file: string, header: readonly string[], cols: readonly string[]): void {
  const missing = cols.filter((c) => !header.includes(c));
  if (missing.length) throw new UberFormatError(`${file} 缺少欄位：${missing.join('、')}。Uber 可能改了格式，請把檔案的第一行給開發者看。`);
}

export const checkTripsHeader = (h: readonly string[]) => requireColumns('driver_lifetime_trips', h, TRIP_COLUMNS);
export const checkStatesHeader = (h: readonly string[]) => requireColumns('driver_online_offline', h, STATE_COLUMNS);
export const checkAnalyticsHeader = (h: readonly string[]) => requireColumns('driver_app_analytics', h, ANALYTICS_COLUMNS);

/** 'YYYY-MM-DD HH:mm:ss'（沒有時區，是 UTC）或 ISO 字串 → epoch ms */
export function parseUtc(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

const num = (s: string | undefined): number => {
  const n = Number(s);
  return s != null && s !== '' && Number.isFinite(n) ? n : 0;
};

/** 四捨五入，剛好 .5 時往下（和 Uber 卡片金額的進位方式一致） */
export const roundHalfDown = (x: number): number => Math.ceil(x - 0.5);

/**
 * 司機實收 =（原始車資 − 訂車費）×（1 − 服務費率），四捨五入（.5 往下），再加過路費。
 * 2026-11-18 的 10 趟和行程影片卡片金額完全一致，歷年各週加總和週報表也一致（中位數比值 1.000）。
 * 也就是說，卡片上的大字金額是扣掉服務費之後的司機收入（SPEC 8.4 的待確認事項）。
 */
export function driverEarnings(r: Row): number {
  const rate = num(r.service_fee) || 0.25;
  return roundHalfDown((num(r.original_fare_local) - num(r.booking_fee_local)) * (1 - rate)) + num(r.toll_amount_local);
}

export function tripFromRow(r: Row, now: number): ImportedTrip | null {
  if (r.status !== 'completed') return null;
  const req = parseUtc(r.request_timestamp_utc);
  if (req == null) return null;
  const pick = parseUtc(r.begintrip_timestamp_utc);
  const drop = parseUtc(r.dropoff_timestamp_utc);
  const dur = num(r.trip_duration_seconds) || (pick != null && drop != null ? (drop - pick) / 1000 : 0);
  const miles = num(r.trip_distance_miles);
  return {
    id: `uber-trip-${req}`,
    source: 'uber_zip',
    externalId: null,
    dedupeKey: `uber|${req}`,
    requestTs: req,
    pickupTs: pick,
    dropoffTs: drop,
    durationSec: dur ? Math.round(dur) : null,
    distanceKm: miles ? Math.round(miles * 1.609344 * 100) / 100 : null,
    pickupLat: null,
    pickupLon: null,
    dropoffLat: null,
    dropoffLon: null,
    pickupAddress: null,
    dropoffAddress: null,
    pickupPrecision: null,
    dropoffPrecision: null,
    fare: driverEarnings(r),
    surge: Math.round(num(r.surge_fare_local)),
    product: r.product_type_name || null,
    matchedDropoffEventId: null,
    raw: {
      city: r.city_name ?? '',
      surgeMultiplier: r.surge_multiplier ?? '',
      originalFare: r.original_fare_local ?? '',
      bookingFee: r.booking_fee_local ?? '',
      serviceFeeRate: r.service_fee ?? '',
    },
    updatedAt: now,
  };
}

/** 上線狀態 → 空車時段：每一段 open，看下一段是不是 enroute（接到單）或 offline（截尾） */
export function idleFromStates(rows: readonly Row[], now: number): ImportedIdle[] {
  const s = rows
    .map((r) => ({ state: r.earner_state ?? '', start: parseUtc(r.begin_timestamp_utc), end: parseUtc(r.end_timestamp_utc) }))
    .filter((x): x is { state: string; start: number; end: number } => x.start != null && x.end != null)
    .sort((a, b) => a.start - b.start);
  const out: ImportedIdle[] = [];
  for (let i = 0; i < s.length; i++) {
    const cur = s[i]!;
    if (cur.state !== 'open' || cur.end <= cur.start) continue;
    const next = s[i + 1];
    out.push({
      id: `uber-idle-${cur.start}`,
      source: 'uber_zip',
      start: cur.start,
      end: cur.end,
      endedWithOrder: next?.state === 'enroute' && next.start - cur.end < 60_000,
      path: null,
      updatedAt: now,
    });
  }
  return out;
}

export interface GpsPoint {
  ts: number;
  lat: number;
  lon: number;
}

export function pointFromAnalytics(r: Row): GpsPoint | null {
  if (r['msg.driver_app.driver_online'] !== 'true') return null;
  const ts = parseUtc(r.time);
  const lat = Number(r['msg.location.lat']);
  const lon = Number(r['msg.location.lng']);
  if (ts == null || !lat || !lon || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { ts, lat, lon };
}

/**
 * 把 App 分析的定位點放進對應的空車時段，當作這段時間的軌跡。
 * 和自己的軌跡一樣稀疏化：相隔 30 秒以上、移動 20 公尺以上才留一點。
 */
export function attachPaths(idle: ImportedIdle[], points: GpsPoint[], intervalSec = 30, minMoveM = 20): number {
  const pts = [...points].sort((a, b) => a.ts - b.ts);
  let j = 0;
  let filled = 0;
  for (const p of [...idle].sort((a, b) => a.start - b.start)) {
    while (j < pts.length && pts[j]!.ts < p.start) j++;
    const path: [number, number, number][] = [];
    let last: GpsPoint | null = null;
    for (let k = j; k < pts.length && pts[k]!.ts <= p.end; k++) {
      const q = pts[k]!;
      if (last && (q.ts - last.ts < intervalSec * 1000 || distanceM(last, q) < minMoveM)) continue;
      path.push([q.ts, Math.round(q.lat * 1e6) / 1e6, Math.round(q.lon * 1e6) / 1e6]);
      last = q;
    }
    if (path.length) {
      p.path = path;
      filled++;
    }
  }
  return filled;
}

/**
 * 影片行程和官方行程對上（同一分鐘接單、行程時長相差 2 秒內）：
 * 影片補上準確的上客、下客時間；地址與精度維持影片的（SPEC 8.6 第 4 點）。
 */
export function matchVideoTrips(video: readonly ImportedTrip[], official: readonly ImportedTrip[], now: number): ImportedTrip[] {
  const byMinute = new Map<number, ImportedTrip[]>();
  for (const o of official) {
    if (o.requestTs == null) continue;
    const k = Math.floor(o.requestTs / 60_000);
    const arr = byMinute.get(k) ?? [];
    arr.push(o);
    byMinute.set(k, arr);
  }
  const out: ImportedTrip[] = [];
  for (const v of video) {
    if (v.source !== 'video' || v.requestTs == null || v.raw.uberRequestTs) continue;
    const k = Math.floor(v.requestTs / 60_000);
    const hit = (byMinute.get(k) ?? []).find((o) => v.durationSec != null && o.durationSec != null && Math.abs(o.durationSec - v.durationSec) <= 2);
    if (!hit) continue;
    out.push({
      ...v,
      requestTs: hit.requestTs,
      pickupTs: hit.pickupTs,
      dropoffTs: hit.dropoffTs,
      raw: { ...v.raw, uberRequestTs: String(hit.requestTs), uberFare: String(hit.fare ?? '') },
      updatedAt: now,
    });
  }
  return out;
}

export function checkBonusHeader(h: readonly string[]): void {
  const missing = BONUS_COLUMNS.filter((c) => !h.includes(c));
  if (missing.length) throw new UberFormatError(`miscellaneous_payments 缺少欄位：${missing.join('、')}`);
}

export function bonusKind(type: string): ImportedBonus['kind'] {
  if (/^Engagement/i.test(type)) return 'quest';
  if (/service fee discount/i.test(type)) return 'fee_discount';
  return 'other';
}

/** 給人看的短標籤：「尖峰時段額外趟次挑戰：完成 10 趟（等級 1）」 */
export function bonusLabel(type: string, description: string): string {
  const kind = bonusKind(type);
  if (kind === 'fee_discount') return '服務費折扣';
  if (kind === 'other') return type;
  const name = description.split(/[（(]/)[0]!.trim() || '趟獎';
  const trips = description.match(/完成\s*(\d+)\s*趟/)?.[1];
  const level = description.match(/等級\s*(\d+)/)?.[1];
  return `${name}${trips ? `：完成 ${trips} 趟` : ''}${level ? `（等級 ${level}）` : ''}`;
}

/** 日期只有年月日（台北時間），放在當天中午，週、月歸屬才不會因時區跑掉 */
function taipeiNoon(date: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 4);
}

/** 同一天、同金額、同類型可能有好幾筆，用出現順序區分，重複匯入同一份檔案 id 不變 */
export function bonusesFromRows(rows: readonly Row[], now: number): ImportedBonus[] {
  const seen = new Map<string, number>();
  const out: ImportedBonus[] = [];
  for (const r of rows) {
    const ts = taipeiNoon(r['Date Created'] ?? '');
    const amount = Number(r.Amount);
    if (ts == null || !Number.isFinite(amount) || amount === 0) continue;
    const type = (r.TYPE ?? '').trim();
    const base = `${(r['Date Created'] ?? '').slice(0, 10)}-${amount}-${type}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({
      id: `uber-bonus-${base}-${n}`,
      source: 'uber_zip',
      ts,
      amount,
      kind: bonusKind(type),
      label: bonusLabel(type, r.Description ?? ''),
      updatedAt: now,
    });
  }
  return out;
}

/** 算進時薪的額外收入（趟獎＋服務費折扣） */
export const countsAsEarnings = (b: ImportedBonus): boolean => b.kind !== 'other';

export interface UberSummary {
  trips: number;
  firstTs: number | null;
  lastTs: number | null;
  earnings: number;
  idlePeriods: number;
  idleHours: number;
  withPath: number;
  points: number;
  quests: number;
  questTotal: number;
  feeDiscountTotal: number;
}

export function summarize(
  trips: readonly ImportedTrip[],
  idle: readonly ImportedIdle[],
  points: number,
  bonus: readonly ImportedBonus[] = [],
): UberSummary {
  const quests = bonus.filter((b) => b.kind === 'quest');
  const ts = trips.map((t) => t.requestTs!).sort((a, b) => a - b);
  return {
    trips: trips.length,
    firstTs: ts[0] ?? null,
    lastTs: ts[ts.length - 1] ?? null,
    earnings: trips.reduce((s, t) => s + (t.fare ?? 0), 0),
    idlePeriods: idle.length,
    idleHours: idle.reduce((s, p) => s + (p.end - p.start) / 3_600_000, 0),
    withPath: idle.filter((p) => p.path).length,
    points,
    quests: quests.length,
    questTotal: quests.reduce((s, b) => s + b.amount, 0),
    feeDiscountTotal: bonus.filter((b) => b.kind === 'fee_discount').reduce((s, b) => s + b.amount, 0),
  };
}
