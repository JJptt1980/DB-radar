import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DEFAULT_BACKUP_META,
  DEFAULT_SETTINGS,
  type BackupMeta,
  SCHEMA_VERSION,
  type BackupFile,
  type Fare,
  type ImportedTrip,
  type Settings,
  type TrackPoint,
  type TripEvent,
} from './types';
import { mergeById } from '../domain/merge';

interface RadarDB extends DBSchema {
  events: { key: string; value: TripEvent; indexes: { ts: number; shiftId: string } };
  fares: { key: string; value: Fare };
  trackPoints: { key: string; value: TrackPoint; indexes: { ts: number; shiftId: string } };
  importedTrips: { key: string; value: ImportedTrip; indexes: { dedupeKey: string } };
  kv: { key: string; value: unknown };
}

// IndexedDB 的版本號跟著 SCHEMA_VERSION 走；之後加 migration 時在 upgrade 依 oldVersion 逐步升級。
let dbPromise: Promise<IDBPDatabase<RadarDB>> | null = null;

export function db(): Promise<IDBPDatabase<RadarDB>> {
  dbPromise ??= openDB<RadarDB>('db-radar', SCHEMA_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const ev = d.createObjectStore('events', { keyPath: 'id' });
        ev.createIndex('ts', 'ts');
        ev.createIndex('shiftId', 'shiftId');
        d.createObjectStore('fares', { keyPath: 'id' });
        const tp = d.createObjectStore('trackPoints', { keyPath: 'id' });
        tp.createIndex('ts', 'ts');
        tp.createIndex('shiftId', 'shiftId');
        const it = d.createObjectStore('importedTrips', { keyPath: 'id' });
        it.createIndex('dedupeKey', 'dedupeKey');
        d.createObjectStore('kv');
      }
    },
  });
  return dbPromise;
}

export const uuid = (): string => crypto.randomUUID();

export async function getAllEvents(): Promise<TripEvent[]> {
  return (await db()).getAll('events');
}

export async function putEvent(e: TripEvent): Promise<void> {
  await (await db()).put('events', e);
}

export async function getAllFares(): Promise<Fare[]> {
  return (await db()).getAll('fares');
}

export async function putFare(f: Fare): Promise<void> {
  await (await db()).put('fares', f);
}

export async function addTrackPoint(p: TrackPoint): Promise<void> {
  await (await db()).put('trackPoints', p);
}

export async function lastTrackPoint(): Promise<TrackPoint | null> {
  const cur = await (await db()).transaction('trackPoints').store.index('ts').openCursor(null, 'prev');
  return cur?.value ?? null;
}

export async function countTrackPoints(shiftId?: string): Promise<number> {
  const d = await db();
  return shiftId ? d.countFromIndex('trackPoints', 'shiftId', shiftId) : d.count('trackPoints');
}

export async function getSettings(): Promise<Settings> {
  const s = (await (await db()).get('kv', 'settings')) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('kv', s, 'settings');
}

export async function exportAll(): Promise<BackupFile> {
  const d = await db();
  const [events, fares, trackPoints, importedTrips, settings] = await Promise.all([
    d.getAll('events'),
    d.getAll('fares'),
    d.getAll('trackPoints'),
    d.getAll('importedTrips'),
    getSettings(),
  ]);
  return {
    app: 'db-radar',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    events,
    fares,
    trackPoints,
    importedTrips,
    settings,
  };
}

export interface ImportResult {
  added: number;
  updated: number;
}

/** 合併匯入（依 id，取 updatedAt 較新者）。設定只在本機還沒存過時才採用檔案裡的。 */
export async function mergeImport(b: BackupFile): Promise<ImportResult> {
  const d = await db();
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'kv'], 'readwrite');
  let added = 0;
  let updated = 0;
  const stores = ['events', 'fares', 'trackPoints', 'importedTrips'] as const;
  for (const name of stores) {
    const store = tx.objectStore(name);
    const local = (await store.getAll()) as { id: string; updatedAt?: number }[];
    const r = mergeById(local, b[name] as { id: string; updatedAt?: number }[]);
    added += r.added;
    updated += r.updated;
    for (const rec of r.toWrite) await store.put(rec as never);
  }
  const kv = tx.objectStore('kv');
  if (!(await kv.get('settings')) && b.settings && Object.keys(b.settings).length) {
    await kv.put({ ...DEFAULT_SETTINGS, ...b.settings }, 'settings');
  }
  await tx.done;
  return { added, updated };
}

export async function clearAll(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'kv'], 'readwrite');
  await Promise.all([
    tx.objectStore('events').clear(),
    tx.objectStore('fares').clear(),
    tx.objectStore('trackPoints').clear(),
    tx.objectStore('importedTrips').clear(),
    tx.objectStore('kv').clear(),
    tx.done,
  ]);
}

export async function getAllImportedTrips(): Promise<ImportedTrip[]> {
  return (await db()).getAll('importedTrips');
}

export async function putImportedTrips(trips: readonly ImportedTrip[]): Promise<void> {
  const tx = (await db()).transaction('importedTrips', 'readwrite');
  await Promise.all([...trips.map((t) => tx.store.put(t)), tx.done]);
}

export async function getBackupMeta(): Promise<BackupMeta> {
  const m = (await (await db()).get('kv', 'backupMeta')) as Partial<BackupMeta> | undefined;
  return { ...DEFAULT_BACKUP_META, ...m };
}

export async function saveBackupMeta(m: BackupMeta): Promise<void> {
  await (await db()).put('kv', m, 'backupMeta');
}

/** 覆蓋還原：清掉事件、車資、軌跡、匯入行程與設定，換成備份檔的內容（Drive 連結狀態保留）。 */
export async function replaceAll(b: BackupFile): Promise<number> {
  const d = await db();
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'kv'], 'readwrite');
  const stores = ['events', 'fares', 'trackPoints', 'importedTrips'] as const;
  let n = 0;
  for (const name of stores) {
    const store = tx.objectStore(name);
    await store.clear();
    for (const rec of b[name]) {
      await store.put(rec as never);
      n++;
    }
  }
  await tx.objectStore('kv').put({ ...DEFAULT_SETTINGS, ...b.settings }, 'settings');
  await tx.done;
  return n;
}
