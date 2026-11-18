// 在瀏覽器（或 Node 測試）裡讀 Uber zip：只解壓需要的 3 個 CSV，其他檔案（含個資）不碰。
import JSZip from 'jszip';
import Papa from 'papaparse';
import type { ImportedIdle, ImportedTrip } from '../db/types';
import {
  ANALYTICS_COLUMNS,
  UBER_FILES,
  UberFormatError,
  attachPaths,
  checkAnalyticsHeader,
  checkStatesHeader,
  checkTripsHeader,
  idleFromStates,
  pointFromAnalytics,
  tripFromRow,
  type GpsPoint,
  type Row,
} from './uber';

export interface UberParsed {
  trips: ImportedTrip[];
  idle: ImportedIdle[];
  points: number;
  /** zip 裡有、但沒有讀的檔案（給使用者看，讓他知道個資沒有被載入） */
  skipped: string[];
}

type Progress = (msg: string) => void;

/** JSZip 自己的 UTF-8 解碼在瀏覽器很慢，改用原生 TextDecoder */
async function readText(zip: JSZip, name: string): Promise<string> {
  // TextDecoder 預設會去掉開頭的 UTF-8 BOM，表頭第一欄才比對得到
  return new TextDecoder('utf-8').decode(await zip.file(name)!.async('uint8array'));
}

/** 一般 CSV：整份解析成陣列，再依欄位位置取值（比每列建物件快很多） */
function parseCsv(text: string, onHeader: (h: string[]) => void, onRow: (r: Row) => void, keep?: readonly string[]): void {
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
  const [header, ...rows] = res.data;
  if (!header) return;
  onHeader(header);
  const cols = (keep ?? header).map((name) => [name, header.indexOf(name)] as const).filter(([, i]) => i >= 0);
  for (const r of rows) {
    const o: Row = {};
    for (const [name, i] of cols) o[name] = r[i] ?? '';
    onRow(o);
  }
}

/**
 * App 分析檔很大（數十 MB）。需要的四個欄位剛好在每一行的最前面（time、driver_online）與最後面（lat、lng），
 * 而且都是不含逗號、引號的簡單值，所以直接切字串取值，不用完整解析中間那些含引號的欄位（裡面也是不需要的個資）。
 * 表頭順序不符時改用完整解析。每處理一批就讓出主執行緒，畫面不會卡住。
 */
async function scanAnalytics(text: string, onPoint: (p: GpsPoint) => void, progress: Progress): Promise<void> {
  const nl = text.indexOf('\n');
  const header = Papa.parse<string[]>(text.slice(0, nl), { header: false }).data[0] ?? [];
  checkAnalyticsHeader(header);
  const n = header.length;
  const iTime = header.indexOf('time');
  const iOnline = header.indexOf('msg.driver_app.driver_online');
  const iLat = header.indexOf('msg.location.lat');
  const iLng = header.indexOf('msg.location.lng');
  const fastOk = iTime < 4 && iOnline < 4 && iLat >= n - 6 && iLng >= n - 6;
  if (!fastOk) {
    parseCsv(text, () => undefined, (r) => {
      const p = pointFromAnalytics(r);
      if (p) onPoint(p);
    }, ANALYTICS_COLUMNS);
    return;
  }
  const head = Math.max(iTime, iOnline) + 1;
  const tail = n - Math.min(iLat, iLng);
  let pos = nl + 1;
  let batch = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    // 前 head 個欄位
    const first: string[] = [];
    let a = 0;
    for (let k = 0; k < head; k++) {
      const c = line.indexOf(',', a);
      first.push(line.slice(a, c < 0 ? line.length : c));
      a = c + 1;
    }
    // 後 tail 個欄位
    const last: string[] = [];
    let b = line.length;
    for (let k = 0; k < tail; k++) {
      const c = line.lastIndexOf(',', b - 1);
      last.unshift(line.slice(c + 1, b));
      b = c;
    }
    const row: Row = {
      time: first[iTime] ?? '',
      'msg.driver_app.driver_online': first[iOnline] ?? '',
      'msg.location.lat': last[iLat - (n - tail)] ?? '',
      'msg.location.lng': last[iLng - (n - tail)] ?? '',
    };
    const p = pointFromAnalytics(row);
    if (p) onPoint(p);
    if (++batch % 20000 === 0) {
      progress(`讀取 App 定位… ${Math.round((pos / text.length) * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

export async function parseUberZip(data: Blob | ArrayBuffer | Uint8Array, progress: Progress = () => undefined): Promise<UberParsed> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new UberFormatError('讀不懂這個檔案，請選 Uber 寄來的 zip 檔');
  }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const find = (re: RegExp) => names.find((n) => re.test(n));
  const tripsName = find(UBER_FILES.trips);
  const statesName = find(UBER_FILES.states);
  const analyticsName = find(UBER_FILES.analytics);
  if (!tripsName) throw new UberFormatError('zip 裡找不到 driver_lifetime_trips（職業駕駛終身行程）');
  const used = new Set([tripsName, statesName, analyticsName].filter(Boolean));
  const skipped = names.filter((n) => !used.has(n));
  const now = Date.now();

  progress('讀取行程…');
  await new Promise((r) => setTimeout(r, 0));
  const trips: ImportedTrip[] = [];
  const seen = new Set<string>();
  parseCsv(await readText(zip, tripsName), checkTripsHeader, (r) => {
    const t = tripFromRow(r, now);
    // Uber 的檔案偶爾把同一趟列兩次（trip_offer_type 一筆 standard、一筆 others），只留一筆
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      trips.push(t);
    }
  });

  let idle: ImportedIdle[] = [];
  if (statesName) {
    progress('讀取上線狀態…');
    await new Promise((r) => setTimeout(r, 0));
    const rows: Row[] = [];
    parseCsv(
      await readText(zip, statesName),
      checkStatesHeader,
      (r) => rows.push(r),
      ['earner_state', 'begin_timestamp_utc', 'end_timestamp_utc'],
    );
    idle = idleFromStates(rows, now);
  }

  let points = 0;
  if (analyticsName && idle.length) {
    progress('讀取 App 定位…');
    const pts: GpsPoint[] = [];
    // 只取時間、經緯度、是否上線
    await scanAnalytics(await readText(zip, analyticsName), (p) => pts.push(p), progress);
    points = pts.length;
    attachPaths(idle, pts);
  }
  return { trips, idle, points, skipped };
}
