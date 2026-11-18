// 資料模型（SPEC 第 2.2 節）。改動資料格式時要遞增 SCHEMA_VERSION 並寫 migration。

export const SCHEMA_VERSION = 1;

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
  requestTs: number | null;
  pickupTs: number | null;
  dropoffTs: number | null;
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
};

export interface BackupFile {
  app: 'db-radar';
  schemaVersion: number;
  exportedAt: number;
  events: TripEvent[];
  fares: Fare[];
  trackPoints: TrackPoint[];
  importedTrips: ImportedTrip[];
  settings: Settings;
}
