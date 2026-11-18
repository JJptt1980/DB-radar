// 備份流程（SPEC 6.2、6.3）：手動／下線自動備份、保留 30 份、還原（合併或覆蓋）。
import { exportAll, getBackupMeta, mergeImport, replaceAll, saveBackupMeta, type ImportResult } from '../db/db';
import type { BackupMeta } from '../db/types';
import { parseBackup } from '../domain/merge';
import { backupFileName } from '../domain/time';
import {
  DEFAULT_CLIENT_ID,
  DriveAuthError,
  authorize,
  deleteFile,
  downloadFile,
  ensureFolder,
  hasToken,
  listBackups,
  signOut,
  uploadFile,
  type DriveFile,
} from './drive';
import { gzip, readMaybeGzip } from './localFile';
import { backupsToDelete } from './policy';

type Listener = (m: BackupMeta) => void;
let meta: BackupMeta | null = null;
const listeners = new Set<Listener>();

export async function loadMeta(): Promise<BackupMeta> {
  meta = await getBackupMeta();
  return meta;
}

export const currentMeta = (): BackupMeta | null => meta;

export function onMeta(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

async function update(patch: Partial<BackupMeta>): Promise<BackupMeta> {
  meta = { ...(meta ?? (await getBackupMeta())), ...patch };
  await saveBackupMeta(meta);
  listeners.forEach((l) => l(meta!));
  return meta;
}

export const clientIdFrom = (override: string): string => override.trim() || DEFAULT_CLIENT_ID;

let running: Promise<unknown> | null = null;

/** 一次只做一件 Drive 工作，避免連按兩次產生兩份備份 */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = (running ?? Promise.resolve()).catch(() => undefined).then(fn);
  running = p.finally(() => {
    if (running === p) running = null;
  });
  return p;
}

async function ready(clientId: string, interactive: boolean): Promise<string> {
  if (!hasToken()) await authorize(clientId, interactive);
  const m = meta ?? (await loadMeta());
  const folderId = await ensureFolder(m.folderId);
  if (folderId !== m.folderId || !m.linked) await update({ folderId, linked: true });
  return folderId;
}

export interface BackupResult {
  name: string;
  deleted: number;
}

/** 立即備份。interactive = true 才可能跳出 Google 登入畫面（要由使用者點擊觸發）。 */
export function backupNow(clientId: string, interactive: boolean): Promise<BackupResult> {
  return exclusive(async () => {
    try {
      const folderId = await ready(clientId, interactive);
      const data = await exportAll();
      const name = backupFileName(data.exportedAt);
      await uploadFile(folderId, name, await gzip(JSON.stringify(data)));
      const old = backupsToDelete(await listBackups(folderId));
      for (const f of old) await deleteFile(f.id);
      await update({ lastBackupAt: data.exportedAt, lastBackupName: name, pending: false, lastError: null });
      return { name, deleted: old.length };
    } catch (e) {
      await update({ pending: true, lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  });
}

/**
 * 按「下線」後自動備份：只在已連結、而且不需要跳出登入畫面時才做；
 * 做不到就記下「待備份」，等使用者有網路時點一下再補做。
 */
export async function autoBackup(clientId: string): Promise<'done' | 'pending' | 'off'> {
  const m = meta ?? (await loadMeta());
  if (!m.linked) return 'off';
  if (!navigator.onLine) {
    await update({ pending: true, lastError: '下線時沒有網路' });
    return 'pending';
  }
  try {
    if (!hasToken()) await authorize(clientId, false);
    await backupNow(clientId, false);
    return 'done';
  } catch (e) {
    await update({ pending: true, lastError: e instanceof DriveAuthError ? '需要重新登入 Google' : String(e) });
    return 'pending';
  }
}

/** App 開啟時：如果之前連結過，就安靜地試著取得權杖（不跳畫面），有待備份就順便補做 */
export async function resumeOnStart(clientId: string): Promise<void> {
  const m = await loadMeta();
  listeners.forEach((l) => l(m));
  if (!m.linked || !navigator.onLine) return;
  try {
    await authorize(clientId, false);
    if (m.pending) await backupNow(clientId, false);
  } catch {
    // 安靜失敗：等使用者點擊時再登入
  }
}

export function connect(clientId: string): Promise<void> {
  return exclusive(async () => {
    await ready(clientId, true);
  });
}

export async function disconnect(): Promise<void> {
  signOut();
  await update({ linked: false, pending: false, lastError: null });
}

export function listRemote(clientId: string): Promise<DriveFile[]> {
  return exclusive(async () => listBackups(await ready(clientId, true)));
}

export type RestoreMode = 'merge' | 'overwrite';

export function restore(clientId: string, file: DriveFile, mode: RestoreMode): Promise<ImportResult & { total: number }> {
  return exclusive(async () => {
    await ready(clientId, true);
    const data = parseBackup(JSON.parse(await readMaybeGzip(await downloadFile(file.id))));
    if (mode === 'overwrite') {
      const total = await replaceAll(data);
      return { added: total, updated: 0, total };
    }
    const r = await mergeImport(data);
    return { ...r, total: data.events.length };
  });
}
