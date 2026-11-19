import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DEFAULT_BACKUP_META,
  DEFAULT_SETTINGS,
  type BackupMeta,
  SCHEMA_VERSION,
  type BackupFile,
  type Fare,
  type ImportedBonus,
  type ImportedIdle,
  type ImportedTrip,
  type Settings,
  type TrackPoint,
  type TripEvent,
} from './types';
import { mergeById } from '../domain/merge';
import { migrateTripV1 } from '../domain/migrate';

interface RadarDB extends DBSchema {
  events: { key: string; value: TripEvent; indexes: { ts: number; shiftId: string } };
  fares: { key: string; value: Fare };
  trackPoints: { key: string; value: TrackPoint; indexes: { ts: number; shiftId: string } };
  importedTrips: { key: string; value: ImportedTrip; indexes: { dedupeKey: string } };
  importedIdle: { key: string; value: ImportedIdle; indexes: { start: number } };
  importedBonus: { key: string; value: ImportedBonus };
  kv: { key: string; value: unknown };
}

// IndexedDB 的版本號跟著 SCHEMA_VERSION 走；之後加 migration 時在 upgrade 依 oldVersion 逐步升級。
let dbPromise: Promise<IDBPDatabase<RadarDB>> | null = null;

export function db(): Promise<IDBPDatabase<RadarDB>> {
  dbPromise ??= openDB<RadarDB>('db-radar', SCHEMA_VERSION, {
    async upgrade(d, oldVersion, _newVersion, tx) {
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
      if (oldVersion < 2) {
        d.createObjectStore('importedIdle', { keyPath: 'id' }).createIndex('start', 'start');
        // 影片行程的卡片時間搬到 requestTs（見 domain/migrate.ts）
        let cur = await tx.objectStore('importedTrips').openCursor();
        while (cur) {
          const next = migrateTripV1(cur.value);
          if (next !== cur.value) await cur.update(next);
          cur = await cur.continue();
        }
      }
      if (oldVersion < 3) {
        d.createObjectStore('importedBonus', { keyPath: 'id' });
      }
    },
  });
  return dbPromise;
}

export const uuid = (): string => crypto.randomUUID();

/** 開發用假資料的 id 前綴 */
export const FAKE_PREFIX = 'dev-';

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
  const out = { ...DEFAULT_SETTINGS, ...s };
  // 舊預設 6 km 太小，打開雷達常常什麼都看不到；設定頁沒有改這個值的地方，所以直接換成新預設
  if (out.maxRadarKm === 6) out.maxRadarKm = DEFAULT_SETTINGS.maxRadarKm;
  // 縮放按鈕不再放上方角落
  if (!['bl', 'bc', 'br'].includes(out.radarCorner)) out.radarCorner = DEFAULT_SETTINGS.radarCorner;
  return out;
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('kv', s, 'settings');
}

export async function exportAll(): Promise<BackupFile> {
  const d = await db();
  const [events, fares, trackPoints, importedTrips, importedIdle, importedBonus, settings] = await Promise.all([
    d.getAll('events'),
    d.getAll('fares'),
    d.getAll('trackPoints'),
    d.getAll('importedTrips'),
    d.getAll('importedIdle'),
    d.getAll('importedBonus'),
    getSettings(),
  ]);
  // 開發用假資料（id 以 dev- 開頭）不進備份
  const real = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !r.id.startsWith(FAKE_PREFIX));
  return {
    app: 'db-radar',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    events: real(events),
    fares: real(fares),
    trackPoints: real(trackPoints),
    importedTrips,
    importedIdle,
    importedBonus,
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
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'importedIdle', 'importedBonus', 'kv'], 'readwrite');
  let added = 0;
  let updated = 0;
  const stores = ['events', 'fares', 'trackPoints', 'importedTrips', 'importedIdle', 'importedBonus'] as const;
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
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'importedIdle', 'importedBonus', 'kv'], 'readwrite');
  await Promise.all([
    tx.objectStore('events').clear(),
    tx.objectStore('fares').clear(),
    tx.objectStore('trackPoints').clear(),
    tx.objectStore('importedTrips').clear(),
    tx.objectStore('importedIdle').clear(),
    tx.objectStore('importedBonus').clear(),
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
  const tx = d.transaction(['events', 'fares', 'trackPoints', 'importedTrips', 'importedIdle', 'importedBonus', 'kv'], 'readwrite');
  const stores = ['events', 'fares', 'trackPoints', 'importedTrips', 'importedIdle', 'importedBonus'] as const;
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

export async function getAllTracks(): Promise<TrackPoint[]> {
  return (await db()).getAll('trackPoints');
}

export async function addFakeData(d: { events: TripEvent[]; fares: Fare[]; tracks: TrackPoint[] }): Promise<void> {
  const tx = (await db()).transaction(['events', 'fares', 'trackPoints'], 'readwrite');
  const ev = tx.objectStore('events');
  const fa = tx.objectStore('fares');
  const tp = tx.objectStore('trackPoints');
  for (const e of d.events) void ev.put(e);
  for (const f of d.fares) void fa.put(f);
  for (const t of d.tracks) void tp.put(t);
  await tx.done;
}

/** 只刪掉假資料（id 以 dev- 開頭），真實資料不動 */
export async function clearFakeData(): Promise<number> {
  const range = IDBKeyRange.bound(FAKE_PREFIX, FAKE_PREFIX + '\uffff');
  const tx = (await db()).transaction(['events', 'fares', 'trackPoints'], 'readwrite');
  const n = await tx.objectStore('events').count(range);
  await Promise.all([
    tx.objectStore('events').delete(range),
    tx.objectStore('fares').delete(range),
    tx.objectStore('trackPoints').delete(range),
    tx.done,
  ]);
  return n;
}

export async function getAllImportedIdle(): Promise<ImportedIdle[]> {
  return (await db()).getAll('importedIdle');
}

export async function getAllImportedBonus(): Promise<ImportedBonus[]> {
  return (await db()).getAll('importedBonus');
}

export async function putImported(
  trips: readonly ImportedTrip[],
  idle: readonly ImportedIdle[],
  bonus: readonly ImportedBonus[] = [],
): Promise<void> {
  const tx = (await db()).transaction(['importedTrips', 'importedIdle', 'importedBonus'], 'readwrite');
  const a = tx.objectStore('importedTrips');
  const b = tx.objectStore('importedIdle');
  const c = tx.objectStore('importedBonus');
  for (const t of trips) void a.put(t);
  for (const i of idle) void b.put(i);
  for (const x of bonus) void c.put(x);
  await tx.done;
}
