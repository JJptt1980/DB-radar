import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/db/types';
import { DAY_TYPES, type Slot } from '../src/analytics/slots';
import { emptyAcc, type Acc, type StatsIndex } from '../src/analytics/stats';
import { quitAdvice } from '../src/analytics/quit';
import { averageHourly, slotHourly } from '../src/analytics/summary';

const S = { ...DEFAULT_SETTINGS, importWeight: 1 };
// 2026-11-18 是週三；台北 20:30 = UTC 12:30
const WED_2030 = Date.UTC(2026, 10, 18, 12, 30);
const WED_2230 = Date.UTC(2026, 10, 18, 14, 30);

// 旺：等 10 分、每單 $300、20 分 → 約 $600/時；淡：等 60 分、每單 $200 → 約 $150/時
const strong = (): Acc => ({ ...emptyAcc(), idleHours: 10, orders: 60, sumNetFare: 60 * 300, fareOrders: 60, sumOrderMinutes: 60 * 20, durOrders: 60 });
const weak = (): Acc => ({ ...emptyAcc(), idleHours: 10, orders: 10, sumNetFare: 10 * 200, fareOrders: 10, sumOrderMinutes: 10 * 20, durOrders: 10 });

/** 只有全城層（官方資料）的假統計：strongHours 旺，其他小時淡，每種日子都一樣 */
function index(strongHours: number[]): StatsIndex {
  const official = new Map<Slot, Acc>();
  for (const d of DAY_TYPES) for (let h = 0; h < 24; h++) official.set(`${d}:${h}`, strongHours.includes(h) ? strong() : weak());
  return { res: 8, cells: new Map(), video: new Map(), official, tripCount: 100, firstTs: 0 };
}

describe('收工建議', () => {
  it('平均落在旺、淡之間，旺時段高於平均、淡時段低於平均', () => {
    const ix = index([6, 7, 8, 9]);
    const avg = averageHourly(ix, S)!;
    expect(slotHourly(ix, S, 'weekday:7')!.hourly).toBeGreaterThan(avg);
    expect(slotHourly(ix, S, 'weekday:20')!.hourly).toBeLessThan(avg * 0.9);
  });

  it('現在旺、等一下轉淡：值得繼續，說幾點收工', () => {
    const a = quitAdvice(index([18, 19, 20, 21]), S, WED_2030)!;
    expect(a.verdict).toBe('keep');
    expect(a.hours.map((h) => h.hour)).toEqual([20, 21, 22, 23, 0, 1]);
    expect(a.short).toMatch(/跑到 2[1-3] 點收工/);
  });

  it('現在淡、接下來 3 小時內回溫：再等等', () => {
    const a = quitAdvice(index([22, 23]), S, WED_2030)!;
    expect(a.verdict).toBe('wait');
    expect(a.short).toMatch(/2[12] 點回溫/);
  });

  it('現在淡、接下來都淡：可以收工（跨午夜也照算）', () => {
    const a = quitAdvice(index([6, 7, 8, 9]), S, WED_2230)!;
    expect(a.verdict).toBe('quit');
    expect(a.hours.map((h) => h.hour)).toEqual([22, 23, 0, 1, 2, 3]);
    expect(a.text).toContain('可以收工');
  });

  it('全部都旺：接下來都不錯', () => {
    const all = Array.from({ length: 24 }, (_, h) => h);
    expect(quitAdvice(index(all), S, WED_2030)!.verdict).toBe('keep');
  });

  it('沒有資料就不給建議', () => {
    const empty: StatsIndex = { res: 8, cells: new Map(), video: new Map(), official: new Map(), tripCount: 0, firstTs: null };
    expect(quitAdvice(empty, S, WED_2030)).toBeNull();
  });
});
