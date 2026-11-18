// 行程影片匯入（SPEC 8.6）：檢查檔案、去重、和按鈕記錄配對。純函式。
import { SCHEMA_VERSION, type Fare, type GeoPrecision, type ImportedTrip, type TripEvent } from '../db/types';
import { BackupFormatError } from '../domain/merge';
import { fmtDateKey } from '../domain/time';
import { migrateTripV1 } from '../domain/migrate';

export interface VideoImportFile {
  sourceVideo: string;
  exportedAt: number;
  trips: ImportedTrip[];
}

/** 影片卡片的時間（接單時間）；舊格式的檔案存在 pickupTs */
export const cardTs = (t: ImportedTrip): number | null => t.requestTs ?? t.pickupTs;

export function parseVideoImport(data: unknown): VideoImportFile {
  if (!data || typeof data !== 'object') throw new BackupFormatError('檔案內容不是 JSON 物件');
  const d = data as Record<string, unknown>;
  if (d.app !== 'db-radar') throw new BackupFormatError('這不是 DB-radar 的檔案');
  if (d.kind !== 'video-import') throw new BackupFormatError('這是備份檔，請到「本機匯出／匯入」使用');
  if (typeof d.schemaVersion !== 'number' || d.schemaVersion > SCHEMA_VERSION) {
    throw new BackupFormatError('檔案版本比 App 新，請先更新 App');
  }
  if (!Array.isArray(d.importedTrips)) throw new BackupFormatError('檔案裡沒有行程');
  const trips = (d.importedTrips as ImportedTrip[]).map((t) =>
    d.schemaVersion === 1 ? migrateTripV1(t) : t,
  );
  for (const t of trips) {
    if (!t || typeof t.id !== 'string' || typeof t.dedupeKey !== 'string' || t.source !== 'video') {
      throw new BackupFormatError('檔案裡有格式不對的行程');
    }
  }
  return {
    sourceVideo: typeof d.sourceVideo === 'string' ? d.sourceVideo : '',
    exportedAt: typeof d.exportedAt === 'number' ? d.exportedAt : 0,
    trips,
  };
}

/** 影片卡片的時間（接單）和按鈕的「接單」相差多少以內算同一趟 */
export const MATCH_WINDOW_MS = 3 * 60_000;

export interface FareSuggestion {
  eventId: string;
  tripId: string;
  fare: number;
  surge: number;
}

export interface VideoImportPlan {
  dates: string[];
  total: number;
  fareSum: number;
  surgeSum: number;
  lowSupport: number;
  precision: Partial<Record<GeoPrecision, number>>;
  /** 要寫入的新行程（已填好 matchedDropoffEventId） */
  toAdd: ImportedTrip[];
  /** dedupeKey 已存在而略過的筆數 */
  skipped: number;
  matched: number;
  /** 對應的車資還是「待補」，可以用影片的車資補上 */
  fareSuggestions: FareSuggestion[];
}

export function planVideoImport(
  file: VideoImportFile,
  existing: readonly ImportedTrip[],
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  now: number,
): VideoImportPlan {
  const keys = new Set(existing.map((t) => t.dedupeKey));
  const live = events.filter((e) => !e.deleted).sort((a, b) => a.ts - b.ts);
  const accepts = live.filter((e) => e.type === 'accept');
  const usedDropoff = new Set(
    existing.map((t) => t.matchedDropoffEventId).filter((x): x is string => !!x),
  );

  /** 接單之後的第一個下客（同一班，中間沒有取消） */
  const dropoffAfter = (a: TripEvent): TripEvent | undefined => {
    const next = live.find((e) => e.ts > a.ts && e.shiftId === a.shiftId && (e.type === 'dropoff' || e.type === 'cancel'));
    return next?.type === 'dropoff' ? next : undefined;
  };

  const plan: VideoImportPlan = {
    dates: [],
    total: file.trips.length,
    fareSum: 0,
    surgeSum: 0,
    lowSupport: 0,
    precision: {},
    toAdd: [],
    skipped: 0,
    matched: 0,
    fareSuggestions: [],
  };
  const dates = new Set<string>();

  for (const t of file.trips) {
    plan.fareSum += t.fare ?? 0;
    plan.surgeSum += t.surge ?? 0;
    if (t.lowSupport) plan.lowSupport++;
    for (const p of [t.pickupPrecision, t.dropoffPrecision]) {
      if (p) plan.precision[p] = (plan.precision[p] ?? 0) + 1;
    }
    const ts = cardTs(t);
    if (ts != null) dates.add(fmtDateKey(ts));

    if (keys.has(t.dedupeKey)) {
      plan.skipped++;
      continue;
    }
    keys.add(t.dedupeKey);

    let matchedDropoffEventId: string | null = null;
    if (ts != null) {
      let best: TripEvent | null = null;
      for (const p of accepts) {
        const diff = Math.abs(p.ts - ts);
        if (diff > MATCH_WINDOW_MS || fmtDateKey(p.ts) !== fmtDateKey(ts)) continue;
        if (!best || diff < Math.abs(best.ts - ts)) best = p;
      }
      const drop = best ? dropoffAfter(best) : undefined;
      if (drop && !usedDropoff.has(drop.id)) {
        usedDropoff.add(drop.id);
        matchedDropoffEventId = drop.id;
        plan.matched++;
        const f = fares.get(drop.id);
        if (f && f.pending && !f.deleted && t.fare != null) {
          plan.fareSuggestions.push({ eventId: drop.id, tripId: t.id, fare: t.fare, surge: t.surge ?? 0 });
        }
      }
    }
    plan.toAdd.push({ ...t, matchedDropoffEventId, updatedAt: now });
  }
  plan.dates = [...dates].sort();
  return plan;
}

export const PRECISION_LABEL: Record<GeoPrecision, string> = {
  gps: 'GPS',
  manual: '手動',
  address: '到門牌',
  lane: '到巷弄',
  poi: '地標',
  street: '只到路名',
  village: '只到里',
  district: '只到區',
};
