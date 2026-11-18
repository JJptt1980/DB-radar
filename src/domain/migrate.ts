// 資料格式升級（SPEC 12：改格式要遞增 schemaVersion 並寫 migration，不能讓已累積的資料遺失）。
import type { BackupFile, ImportedTrip } from '../db/types';

/**
 * v1 → v2：影片行程的卡片時間原本存在 pickupTs（當時以為是上客時間），
 * 對照官方資料後確認是接單時間，改存到 requestTs；上客、下客時間改成未知。
 */
export function migrateTripV1(t: ImportedTrip): ImportedTrip {
  if (t.source !== 'video' || t.requestTs != null || t.pickupTs == null) return t;
  return { ...t, requestTs: t.pickupTs, pickupTs: null, dropoffTs: null };
}

/** 舊版備份檔匯入前先升級 */
export function migrateBackup(b: BackupFile): BackupFile {
  if (b.schemaVersion >= 2) return b;
  return { ...b, importedTrips: b.importedTrips.map(migrateTripV1), importedIdle: b.importedIdle ?? [] };
}
