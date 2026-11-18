// 備份規則（SPEC 6.2）：純函式，方便測試。

export const KEEP_BACKUPS = 30;
export const REMIND_AFTER_MS = 3 * 24 * 3_600_000;

/** 依建立時間排序，只留最新 keep 份，回傳要刪掉的 */
export function backupsToDelete<T extends { createdTime: string; name: string }>(files: readonly T[], keep = KEEP_BACKUPS): T[] {
  const sorted = [...files]
    .filter((f) => /^radar-backup-\d{8}-\d{4}\.json\.gz$/.test(f.name))
    .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
  return sorted.slice(keep);
}

/** 記錄頁要不要提醒備份：有資料、而且超過 3 天沒備份（或從來沒備份過） */
export function needsBackupReminder(lastBackupAt: number | null, firstDataAt: number | null, now: number): boolean {
  if (firstDataAt == null) return false;
  const since = lastBackupAt ?? firstDataAt;
  return now - since > REMIND_AFTER_MS;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
