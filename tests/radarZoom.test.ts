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
