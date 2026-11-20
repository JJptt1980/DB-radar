import { describe, expect, it } from 'vitest';
import { detourKm, homeRoute } from '../src/analytics/home';
import type { Candidate, Recommendation } from '../src/analytics/model';

// 在台北附近，緯度 0.009° ≈ 1 km
const ME = { lat: 25.0, lon: 121.5 };
const HOME = { lat: 25.09, lon: 121.5 }; // 正北 10 km
const at = (dLatKm: number, dLonKm: number) => ({ lat: ME.lat + dLatKm * 0.009, lon: ME.lon + dLonKm * 0.00993 });

const cand = (cell: string, center: { lat: number; lon: number }, score: number, here = false): Candidate =>
  ({ cell, center, score, here, straightKm: 0, distKm: 0, bearing: 0 }) as Candidate;

const rec = (cs: Candidate[], far: Candidate[] = []): Recommendation =>
  ({ slot: 'weekday:22', candidates: cs, far, here: cand('here', ME, 0, true), best: cs[0]!, stay: false, tripCount: 100, enough: true }) as Recommendation;

describe('順路回家', () => {
  it('多繞距離：在路上 0、往反方向多繞兩倍', () => {
    expect(detourKm(ME, at(5, 0), HOME)).toBeCloseTo(0, 1);
    expect(detourKm(ME, at(-2, 0), HOME)).toBeCloseTo(4, 1);
  });

  it('只留多繞 3 km 內的熱點，依時薪排序，不含原地', () => {
    const r = homeRoute(
      rec([cand('here', ME, 999, true), cand('back', at(-5, 0), 900), cand('side', at(5, 1), 400), cand('onway', at(3, 0), 500)]),
      ME,
      HOME,
    );
    expect(r.isOnRoute).toBe(true);
    expect(r.onRoute.map((c) => c.cell)).toEqual(['onway', 'side']);
    expect(r.best!.cell).toBe('onway');
    expect(r.homeKm).toBeCloseTo(10, 0);
  });

  it('雷達範圍外的順路熱點也算', () => {
    const r = homeRoute(rec([cand('back', at(-5, 0), 900)], [cand('farOnWay', at(9, 0), 300)]), ME, HOME);
    expect(r.best!.cell).toBe('farOnWay');
  });

  it('沒有順路的：不空白，改抓多繞最少的熱點', () => {
    const r = homeRoute(rec([cand('back5', at(-5, 0), 900), cand('back2', at(-2, 0), 100)]), ME, HOME);
    expect(r.isOnRoute).toBe(false);
    expect(r.onRoute).toEqual([]);
    expect(r.best!.cell).toBe('back2');
  });

  it('完全沒有熱點才是 null', () => {
    const r = homeRoute(rec([cand('here', ME, 500, true)]), ME, HOME);
    expect(r.best).toBeNull();
  });
});
