// 資料模型（SPEC 第 2.2 節）。改動資料格式時要遞增 SCHEMA_VERSION 並寫 migration。

// v1 → v2（2026-11-19）：新增 importedIdle（Uber 官方資料的空車時段）；
// 影片匯入的卡片時間改存在 requestTs（實際對照官方資料後確認是接單時間，不是上客時間）。
export const SCHEMA_VERSION = 2;

export type EventType =
  | 'online'
  | 'accept'
  | 'pickup'
  | 'dropoff'
  | 'cancel'
  | 'offer_declined'
  | 'offline';

export type DeclineReason = 'too_far' | 'low_fare' | 'wrong_direction' | null;

export interface TripEvent {
  id: string;
  shiftId: string;
  type: EventType;
  ts: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  source: 'button' | 'uber_import' | 'manual_edit';
  declineReason?: DeclineReason;
  updatedAt: number;
  deleted?: boolean;
}

export interface Fare {
  id: string;
  fare: number | null;
  surge: number | null;
  tip: number | null;
  note: string;
  pending: boolean;
  updatedAt: number;
  deleted?: boolean;
}

export interface TrackPoint {
  id: string;
  shiftId: string;
  ts: number;
  lat: number;
  lon: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  updatedAt?: number;
}

export type GeoPrecision = 'gps' | 'manual' | 'address' | 'lane' | 'poi' | 'street' | 'village' | 'district';

export interface ImportedTrip {
  id: string;
  source: 'uber_zip' | 'video';
  externalId: string | null;
  dedupeKey: string;
  /** 接單時間。影片卡片上的時間就是這個（精度到分） */
  requestTs: number | null;
  /** 上客、下客時間：官方資料才有；影片行程和官方資料對上之後補上 */
  pickupTs: number | null;
  dropoffTs: number | null;
  /** 行程時長（上客到下客） */
  durationSec: number | null;
  distanceKm: number | null;
  pickupLat: number | null;
  pickupLon: number | null;
  dropoffLat: number | null;
  dropoffLon: number | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  pickupPrecision: GeoPrecision | null;
  dropoffPrecision: GeoPrecision | null;
  fare: number | null;
  surge: number | null;
  product: string | null;
  lowSupport?: boolean;
  matchedDropoffEventId?: string | null;
  raw: Record<string, string>;
  updatedAt: number;
}

/** Uber 官方資料「上線狀態」裡的一段空車時間（earner_state = open） */
export interface ImportedIdle {
  id: string;
  source: 'uber_zip';
  start: number;
  end: number;
  /** true = 接到單結束（下一個狀態是 enroute）；false = 下線結束（截尾） */
  endedWithOrder: boolean;
  /** 這段時間的 GPS 軌跡 [ts, lat, lon]，只有 App 分析資料涵蓋的最近 30 天才有 */
  path: [number, number, number][] | null;
  updatedAt: number;
}

export interface Settings {
  avgSpeedKmh: number;
  roadFactor: number;
  costPerKm: number;
  h3Res: number;
  radarRingsKm: number[];
  maxRadarKm: number;
  trackIntervalSec: number;
  holidays: string[];
  homeCenter: { lat: number; lon: number };
  fareIncludesSurge: boolean;
  fareIncludesSurgeVerified: boolean;
  gapBreakMin: number;
  importWeight: number;
  /** Google OAuth 用戶端 ID；空字串 = 用建置時設定的預設值 */
  googleClientId: string;
  /** 雷達掃描線動畫（純裝飾，關掉省電） */
  radarSweep: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  avgSpeedKmh: 25,
  roadFactor: 1.3,
  costPerKm: 3,
  h3Res: 8,
  radarRingsKm: [1, 3, 5],
  maxRadarKm: 6,
  trackIntervalSec: 30,
  holidays: [],
  homeCenter: { lat: 25.0478, lon: 121.517 },
  fareIncludesSurge: true,
  fareIncludesSurgeVerified: true,
  gapBreakMin: 45,
  importWeight: 0.3,
  googleClientId: '',
  radarSweep: true,
};

/** Drive 備份狀態，存在 kv（不進備份檔） */
export interface BackupMeta {
  linked: boolean;
  folderId: string | null;
  lastBackupAt: number | null;
  lastBackupName: string | null;
  /** 有資料還沒備份成功（例如下線時沒網路或需要重新登入） */
  pending: boolean;
  lastError: string | null;
}

export const DEFAULT_BACKUP_META: BackupMeta = {
  linked: false,
  folderId: null,
  lastBackupAt: null,
  lastBackupName: null,
  pending: false,
  lastError: null,
};

export interface BackupFile {
  app: 'db-radar';
  schemaVersion: number;
  exportedAt: number;
  events: TripEvent[];
  fares: Fare[];
  trackPoints: TrackPoint[];
  importedTrips: ImportedTrip[];
  importedIdle: ImportedIdle[];
  settings: Settings;
}
