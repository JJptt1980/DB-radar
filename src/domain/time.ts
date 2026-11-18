// 所有時間存 UTC epoch ms，顯示一律轉台北時間（UTC+8，沒有夏令時間）。
const TZ_OFFSET_MS = 8 * 3_600_000;

function parts(ts: number) {
  const d = new Date(ts + TZ_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtTime(ts: number): string {
  const p = parts(ts);
  return `${p2(p.h)}:${p2(p.mi)}`;
}

export function fmtDateKey(ts: number): string {
  const p = parts(ts);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}

/** 給 <input type="datetime-local"> 用的台北時間字串 */
export function toLocalInput(ts: number): string {
  const p = parts(ts);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;
}

/** 把台北時間的 datetime-local 字串轉回 epoch ms；格式不對回傳 null */
export function fromLocalInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0)) - TZ_OFFSET_MS;
}

/** 台北時間當天 00:00 的 epoch ms */
export function startOfTaipeiDay(ts: number): number {
  const p = parts(ts);
  return Date.UTC(p.y, p.mo - 1, p.d) - TZ_OFFSET_MS;
}

export function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} 分鐘`;
  return `${Math.floor(min / 60)} 小時 ${min % 60} 分`;
}

/** 備份檔名：radar-backup-YYYYMMDD-HHmm.json.gz（台北時間） */
export function backupFileName(ts: number): string {
  const p = parts(ts);
  return `radar-backup-${p.y}${p2(p.mo)}${p2(p.d)}-${p2(p.h)}${p2(p.mi)}.json.gz`;
}
