// 本機匯出／匯入（SPEC 6.4）。格式同 6.1，gzip 壓縮。
import { exportAll, mergeImport, type ImportResult } from '../db/db';
import { parseBackup, BackupFormatError } from '../domain/merge';
import { backupFileName } from '../domain/time';

export async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function readMaybeGzip(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return file.text();
}

export type ExportOutcome = 'shared' | 'downloaded' | 'cancelled';

export async function exportToFile(): Promise<{ outcome: ExportOutcome; name: string; count: number }> {
  const data = await exportAll();
  const name = backupFileName(data.exportedAt);
  const blob = await gzip(JSON.stringify(data));
  const file = new File([blob], name, { type: 'application/gzip' });
  const count = data.events.length;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return { outcome: 'shared', name, count };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { outcome: 'cancelled', name, count };
      // 分享失敗就改用下載
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { outcome: 'downloaded', name, count };
}

export async function importFromFile(file: File): Promise<ImportResult> {
  let data: unknown;
  try {
    data = JSON.parse(await readMaybeGzip(file));
  } catch {
    throw new BackupFormatError('讀不懂這個檔案，請選 .json 或 .json.gz 備份檔');
  }
  return mergeImport(parseBackup(data));
}
