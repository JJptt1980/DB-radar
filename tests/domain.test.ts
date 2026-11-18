import { describe, expect, it } from 'vitest';
import type { EventType, Fare, TripEvent } from '../src/db/types';
import {
  allowedActions,
  currentStatus,
  deriveSegments,
  shiftSummary,
  transition,
} from '../src/domain/state';
import { distanceM, shouldRecordTrack } from '../src/domain/geo';
import { backupFileName, fmtTime, fromLocalInput, startOfTaipeiDay, toLocalInput } from '../src/domain/time';
import { BackupFormatError, mergeById, parseBackup } from '../src/domain/merge';

const T0 = Date.UTC(2026, 10, 19, 10, 0, 0); // 台北 18:00
const MIN = 60_000;

function ev(type: EventType, minute: number, extra: Partial<TripEvent> = {}): TripEvent {
  return {
    id: `${type}-${minute}`,
    shiftId: 's1',
    type,
    ts: T0 + minute * MIN,
    lat: null,
    lon: null,
    accuracy: null,
    source: 'button',
    updatedAt: T0 + minute * MIN,
    ...extra,
  };
}

describe('狀態機', () => {
  it('依 SPEC 2.3 轉換', () => {
    expect(transition('offline', 'online')).toBe('idle');
    expect(transition('idle', 'accept')).toBe('enroute');
    expect(transition('enroute', 'pickup')).toBe('ontrip');
    expect(transition('enroute', 'cancel')).toBe('idle');
    expect(transition('ontrip', 'dropoff')).toBe('idle');
    expect(transition('idle', 'offline')).toBe('offline');
    expect(transition('idle', 'offer_declined')).toBe('idle');
  });

  it('不允許的按鈕回傳 null', () => {
    expect(transition('offline', 'accept')).toBeNull();
    expect(transition('ontrip', 'offline')).toBeNull();
    expect(transition('enroute', 'offer_declined')).toBeNull();
  });

  it('每個狀態可按的按鈕都是合法轉換', () => {
    for (const s of ['offline', 'idle', 'enroute', 'ontrip'] as const) {
      for (const a of allowedActions(s)) expect(transition(s, a)).not.toBeNull();
    }
    expect(allowedActions('idle')).toContain('offer_declined');
    expect(allowedActions('enroute')).not.toContain('offer_declined');
  });
});

describe('currentStatus', () => {
  it('沒有事件時是下線', () => {
    expect(currentStatus([])).toEqual({ state: 'offline', shiftId: null, since: null });
  });

  it('從最後一筆事件還原，拒單不重設空車起點', () => {
    const s = currentStatus([ev('online', 0), ev('offer_declined', 5)]);
    expect(s.state).toBe('idle');
    expect(s.shiftId).toBe('s1');
    expect(s.since).toBe(T0);
  });

  it('忽略已刪除的事件，順序依時間而不是陣列順序', () => {
    const s = currentStatus([ev('accept', 10), ev('online', 0), ev('pickup', 15, { deleted: true })]);
    expect(s.state).toBe('enroute');
    expect(s.since).toBe(T0 + 10 * MIN);
  });

  it('下線後沒有 shiftId', () => {
    expect(currentStatus([ev('online', 0), ev('offline', 30)]).shiftId).toBeNull();
  });
});

describe('deriveSegments', () => {
  it('切出空車、接駁、行程，以下線結束的空車段是截尾', () => {
    const segs = deriveSegments([
      ev('online', 0),
      ev('offer_declined', 3),
      ev('accept', 5),
      ev('pickup', 10),
      ev('dropoff', 30),
      ev('offline', 50),
    ]);
    expect(segs.map((s) => [s.kind, s.start.type, s.end?.type, s.censored])).toEqual([
      ['idle', 'online', 'accept', false],
      ['approach', 'accept', 'pickup', false],
      ['trip', 'pickup', 'dropoff', false],
      ['idle', 'dropoff', 'offline', true],
    ]);
  });

  it('取消後回到空車段，進行中的區段沒有終點', () => {
    const segs = deriveSegments([ev('online', 0), ev('accept', 5), ev('cancel', 8)]);
    expect(segs.map((s) => [s.kind, s.end?.type ?? null])).toEqual([
      ['idle', 'accept'],
      ['approach', 'cancel'],
      ['idle', null],
    ]);
  });
});

describe('shiftSummary', () => {
  it('實收 = 車資 + 小費，加成不重複計算', () => {
    const events = [ev('online', 0), ev('accept', 5), ev('pickup', 10), ev('dropoff', 30)];
    const fare: Fare = { id: 'dropoff-30', fare: 300, surge: 50, tip: 20, note: '', pending: false, updatedAt: 0 };
    const sum = shiftSummary(events, new Map([[fare.id, fare]]), 's1', T0 + 60 * MIN);
    expect(sum).toEqual({ trips: 1, earnings: 320, onlineMs: 60 * MIN, hourly: 320 });
  });

  it('待補車資的趟數照算，金額先算 0', () => {
    const events = [ev('online', 0), ev('dropoff', 30)];
    expect(shiftSummary(events, new Map(), 's1', T0 + 30 * MIN).trips).toBe(1);
  });
});

describe('geo', () => {
  it('距離大致正確（台北車站到台北 101 約 5 km）', () => {
    const d = distanceM({ lat: 25.0478, lon: 121.517 }, { lat: 25.0336, lon: 121.5648 });
    expect(d).toBeGreaterThan(4900);
    expect(d).toBeLessThan(5100);
  });

  it('軌跡點：間隔未到或移動太少就略過', () => {
    const a = { ts: 0, lat: 25, lon: 121.5 };
    expect(shouldRecordTrack(null, a, 30)).toBe(true);
    expect(shouldRecordTrack(a, { ts: 10_000, lat: 25.01, lon: 121.5 }, 30)).toBe(false);
    expect(shouldRecordTrack(a, { ts: 31_000, lat: 25.00005, lon: 121.5 }, 30)).toBe(false);
    expect(shouldRecordTrack(a, { ts: 31_000, lat: 25.001, lon: 121.5 }, 30)).toBe(true);
  });
});

describe('時間（台北）', () => {
  it('顯示與輸入互轉', () => {
    expect(fmtTime(T0)).toBe('18:00');
    expect(toLocalInput(T0)).toBe('2026-11-19T18:00:00');
    expect(fromLocalInput('2026-11-19T18:00:00')).toBe(T0);
    expect(fromLocalInput('2026-11-19T18:00')).toBe(T0);
    expect(fromLocalInput('nope')).toBeNull();
  });

  it('台北日界線與備份檔名', () => {
    const lateNight = Date.UTC(2026, 10, 19, 17, 30); // 台北 11/20 01:30
    expect(startOfTaipeiDay(lateNight)).toBe(Date.UTC(2026, 10, 19, 16, 0));
    expect(backupFileName(lateNight)).toBe('radar-backup-20261120-0130.json.gz');
  });
});

describe('合併與備份檔', () => {
  it('依 id 合併，取較新的', () => {
    const local = [
      { id: 'a', updatedAt: 5 },
      { id: 'b', updatedAt: 5 },
    ];
    const incoming = [
      { id: 'a', updatedAt: 9 },
      { id: 'b', updatedAt: 1 },
      { id: 'c', updatedAt: 1 },
    ];
    const r = mergeById(local, incoming);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.toWrite.map((x) => x.id).sort()).toEqual(['a', 'c']);
  });

  it('同一份檔案再匯入一次不會改變任何資料', () => {
    const data = [{ id: 'a', updatedAt: 5 }];
    expect(mergeById(data, data).toWrite).toEqual([]);
  });

  it('拒絕不是 DB-radar 的檔案或比 App 新的版本', () => {
    expect(() => parseBackup({ app: 'other' })).toThrow(BackupFormatError);
    expect(() => parseBackup({ app: 'db-radar', schemaVersion: 99 })).toThrow(/更新 App/);
    expect(() => parseBackup({ app: 'db-radar', kind: 'video-import', schemaVersion: 1 })).toThrow(/影片/);
    expect(() => parseBackup({ app: 'db-radar', schemaVersion: 1, events: [{}] })).toThrow(/id/);
  });

  it('缺少的表當成空陣列', () => {
    const b = parseBackup({ app: 'db-radar', schemaVersion: 1, events: [{ id: 'x' }] });
    expect(b.events).toHaveLength(1);
    expect(b.fares).toEqual([]);
  });
});
