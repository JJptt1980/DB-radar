import { SCHEMA_VERSION, type BackupFile } from '../db/types';
import { migrateBackup } from './migrate';

export interface Versioned {
  id: string;
  updatedAt?: number;
}

/** 依 id 合併，同 id 取 updatedAt 較新者（SPEC 6.3）。回傳要寫入的資料與新增/更新筆數。 */
export function mergeById<T extends Versioned>(
  local: readonly T[],
  incoming: readonly T[],
): { toWrite: T[]; added: number; updated: number } {
  const byId = new Map(local.map((r) => [r.id, r]));
  const toWrite: T[] = [];
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const cur = byId.get(r.id);
    if (!cur) {
      added++;
      toWrite.push(r);
    } else if ((r.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
      updated++;
      toWrite.push(r);
    }
  }
  return { toWrite, added, updated };
}

export class BackupFormatError extends Error {}

/** 檢查備份檔內容，回傳整理過的物件；不符合時丟出 BackupFormatError（訊息給使用者看）。 */
export function parseBackup(data: unknown): BackupFile {
  if (!data || typeof data !== 'object') throw new BackupFormatError('檔案內容不是 JSON 物件');
  const d = data as Record<string, unknown>;
  if (d.app !== 'db-radar') throw new BackupFormatError('這不是 DB-radar 的備份檔');
  if (d.kind === 'video-import') throw new BackupFormatError('這是行程影片匯入檔，請到「行程影片匯入」使用');
  const v = d.schemaVersion;
  if (typeof v !== 'number') throw new BackupFormatError('備份檔缺少版本號');
  if (v > SCHEMA_VERSION) throw new BackupFormatError(`備份檔版本 ${v} 比 App 新，請先更新 App`);
  const arr = (k: string) => {
    const x = d[k];
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw new BackupFormatError(`備份檔的 ${k} 格式不對`);
    for (const r of x) {
      if (!r || typeof r !== 'object' || typeof (r as Versioned).id !== 'string') {
        throw new BackupFormatError(`備份檔的 ${k} 有缺少 id 的資料`);
      }
    }
    return x;
  };
  return migrateBackup({
    app: 'db-radar',
    schemaVersion: v,
    exportedAt: typeof d.exportedAt === 'number' ? d.exportedAt : 0,
    events: arr('events'),
    fares: arr('fares'),
    trackPoints: arr('trackPoints'),
    importedTrips: arr('importedTrips'),
    importedIdle: arr('importedIdle'),
    settings: (d.settings && typeof d.settings === 'object' ? d.settings : {}) as BackupFile['settings'],
  });
}
