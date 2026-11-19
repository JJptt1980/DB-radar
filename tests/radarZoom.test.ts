import { describe, expect, it } from 'vitest';
import { clampRange, clusterDots, clusterRadius, nextZoom, niceStep, zoomStage } from '../src/ui/radarZoom';

describe('雷達縮放', () => {
  it('按鈕三段循環：6 → 3 → 1.5 → 6', () => {
    expect(nextZoom(6, 6)).toBe(3);
    expect(nextZoom(3, 6)).toBe(1.5);
    expect(nextZoom(1.5, 6)).toBe(6);
    expect(nextZoom(4, 6)).toBe(3); // 雙指縮到中間值時往下一段
    expect(nextZoom(1, 6)).toBe(6);
  });
  it('段數與範圍限制', () => {
    expect([zoomStage(6, 6), zoomStage(3.2, 6), zoomStage(1.4, 6)]).toEqual([0, 1, 2]);
    expect([clampRange(0.1, 6), clampRange(9, 6)]).toEqual([0.5, 6]);
  });
  it('好讀的刻度', () => {
    expect([niceStep(2), niceStep(1.2), niceStep(0.6), niceStep(0.3), niceStep(0.18)]).toEqual([2, 2, 1, 0.5, 0.2]);
  });
});

describe('光點合併', () => {
  it('近的合成一個，中心是分數最高的點，點數越多越大', () => {
    const cl = clusterDots(
      [
        { item: 'a', x: 0, y: 0, score: 100 },
        { item: 'b', x: 10, y: 0, score: 300 },
        { item: 'c', x: 25, y: 0, score: 200 },
        { item: 'd', x: 200, y: 0, score: 50 },
      ],
      30,
    );
    expect(cl.map((c) => [c.best, c.count, c.x])).toEqual([['b', 3, 10], ['d', 1, 200]]);
    expect(clusterRadius(1)).toBe(6);
    expect(clusterRadius(3)).toBeGreaterThan(clusterRadius(2));
    expect(clusterRadius(100)).toBe(18);
  });
});

import { fitRange, nearBand } from '../src/ui/radarZoom';

describe('打開雷達自動選範圍', () => {
  it('選最小、但看得到 3 個點和第一名的那一段', () => {
    expect(fitRange([0.5, 1, 2, 9], 1, 12)).toBe(3);
    expect(fitRange([0.5, 1, 2, 9], 5, 12)).toBe(6);
    expect(fitRange([4, 7, 10], 4, 12)).toBe(12);
    expect(fitRange([1], 1, 12)).toBe(3); // 只有一個點也要看得到
    expect(fitRange([], null, 12)).toBe(3);
  });
});

describe('靠近熱點的距離分段', () => {
  it('500／250／100 公尺', () => {
    expect([nearBand(800), nearBand(400), nearBand(200), nearBand(50)]).toEqual([0, 1, 2, 3]);
  });
});

import { MEMES, memeAt, memeByIndex, memeCount } from '../src/ui/memes';

describe('龍珠梗', () => {
  const states = ['idle', 'enroute', 'ontrip', 'offline'] as const;
  it('每個狀態組得出的句數超過一天 2,880 句', () => {
    for (const s of states) expect(memeCount(s)).toBeGreaterThanOrEqual(2880);
  });
  it('30 秒一句，同一天（台北時間）2,880 句全部不一樣', () => {
    const dayStart = Date.UTC(2026, 10, 18, 16); // 台北 11/19 00:00
    for (const s of states) {
      const seen = new Set<string>();
      for (let k = 0; k < 2880; k++) seen.add(memeAt(s, dayStart + k * 30_000 + 5_000, 30));
      expect(seen.size).toBe(2880);
    }
  });
  it('同一個 30 秒內不變；三段每次都會換', () => {
    const t = Date.UTC(2026, 10, 19, 2, 0, 0);
    expect(memeAt('idle', t + 1_000, 30)).toBe(memeAt('idle', t + 29_000, 30));
    const a = memeByIndex('ontrip', 100).split(/[，。]/);
    const b = memeByIndex('ontrip', 101).split(/[，。]/);
    expect(a.filter((x, i) => x === b[i] && x)).toEqual([]);
  });
  it('1 分鐘一句時，同一個片段至少隔 20 句才會再出現', () => {
    const t0 = Date.UTC(2026, 10, 18, 16);
    for (const st of states) {
      const lines = Array.from({ length: 300 }, (_, k) => memeAt(st, t0 + k * 60_000 + 1_000, 60).split(/[，。]/));
      for (const part of [0, 1, 2]) {
        const last = new Map<string, number>();
        lines.forEach((l, k) => {
          const prev = last.get(l[part]!);
          if (prev != null) expect(k - prev).toBeGreaterThanOrEqual(20);
          last.set(l[part]!, k);
        });
      }
    }
  });
  it('片段沒有重複', () => {
    for (const s of states) {
      const p = MEMES[s];
      for (const arr of [p.open, p.mid, p.close]) expect(new Set(arr).size).toBe(arr.length);
    }
  });
});

import { clampTilt } from '../src/ui/useTilt';

describe('體感', () => {
  it('轉動角度有上限', () => {
    expect([clampTilt(30), clampTilt(-30), clampTilt(5)]).toEqual([14, -14, 5]);
  });
});

import { nearBeep } from '../src/ui/radarZoom';

describe('靠近龍珠嗶嗶', () => {
  it('每顆龍珠進入更近的一段才嗶，不會一直響；離開再回來會再響', () => {
    const mem = new Map<string, number>();
    const at = (a: number, b: number) => [
      { cell: 'A', distM: a },
      { cell: 'B', distM: b },
    ];
    expect(nearBeep(mem, at(900, 2000))).toBe(0);
    expect(nearBeep(mem, at(450, 2000))).toBe(1);
    expect(nearBeep(mem, at(420, 2000))).toBe(0); // 同一段不再響
    expect(nearBeep(mem, at(200, 2000))).toBe(2);
    expect(nearBeep(mem, at(80, 2000))).toBe(3);
    expect(nearBeep(mem, at(300, 480))).toBe(1); // 換靠近另一顆
    expect(nearBeep(mem, at(800, 900))).toBe(0); // 都離開了
    expect(nearBeep(mem, at(450, 900))).toBe(1); // 回來再響
  });
});

import { niceRange, radarMaxKm } from '../src/ui/radarZoom';

describe('附近沒有點時放大雷達', () => {
  it('附近有點就維持原本範圍；沒有就放大到看得到最近 3 個點', () => {
    expect(radarMaxKm(12, 3, [20, 25])).toBe(12);
    expect(radarMaxKm(12, 0, [14, 18, 26, 40])).toBe(40); // 第 3 近 26 km × 1.25 → 40
    expect(radarMaxKm(12, 0, [17])).toBe(25);
    expect(radarMaxKm(12, 0, [])).toBe(12);
    expect([niceRange(16), niceRange(44), niceRange(500)]).toEqual([20, 50, 100]);
  });
  it('放大後三段裡第一段看得到點', () => {
    const max = radarMaxKm(12, 0, [14, 18, 26]);
    expect(fitRange([14, 18, 26], 14, max)).toBe(max);
  });
});
