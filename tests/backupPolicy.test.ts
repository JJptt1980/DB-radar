import { describe, expect, it } from 'vitest';
import { REMIND_AFTER_MS, backupsToDelete, fmtBytes, needsBackupReminder } from '../src/backup/policy';

const file = (i: number) => ({
  id: String(i),
  name: `radar-backup-202611${String((i % 28) + 1).padStart(2, '0')}-${String(i % 24).padStart(2, '0')}00.json.gz`,
  createdTime: new Date(Date.UTC(2026, 10, 1) + i * 3_600_000).toISOString(),
});

describe('backupsToDelete', () => {
  it('只留最新 30 份', () => {
    const files = Array.from({ length: 33 }, (_, i) => file(i));
    const del = backupsToDelete(files);
    expect(del.map((f) => f.id).sort()).toEqual(['0', '1', '2']);
  });

  it('不到 30 份就不刪；不是備份檔名的檔案不碰', () => {
    expect(backupsToDelete(Array.from({ length: 30 }, (_, i) => file(i)))).toEqual([]);
    const other = { id: 'x', name: 'notes.txt', createdTime: '2000-01-01T00:00:00Z' };
    expect(backupsToDelete([other, ...Array.from({ length: 31 }, (_, i) => file(i))]).map((f) => f.id)).toEqual(['0']);
  });
});

describe('needsBackupReminder', () => {
  const now = Date.UTC(2026, 10, 20);
  it('沒有資料不提醒', () => {
    expect(needsBackupReminder(null, null, now)).toBe(false);
  });
  it('超過 3 天沒備份才提醒（從沒備份過就從第一筆資料起算）', () => {
    expect(needsBackupReminder(now - REMIND_AFTER_MS + 1000, now - 10 * REMIND_AFTER_MS, now)).toBe(false);
    expect(needsBackupReminder(now - REMIND_AFTER_MS - 1000, now - 10 * REMIND_AFTER_MS, now)).toBe(true);
    expect(needsBackupReminder(null, now - 1000, now)).toBe(false);
    expect(needsBackupReminder(null, now - REMIND_AFTER_MS - 1000, now)).toBe(true);
  });
});

describe('fmtBytes', () => {
  it('人看得懂的大小', () => {
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
