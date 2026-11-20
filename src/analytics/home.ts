// 順路回家（SPEC 4.5.3）：只推薦往家方向、不用多繞太遠的熱點。純函式。
import { bearingDeg, distanceM, type LatLon } from '../domain/geo';
import type { Candidate, Recommendation } from './model';

/** 多繞超過這麼多公里就不算順路 */
export const MAX_DETOUR_KM = 3;

export interface HomeCandidate extends Candidate {
  /** 經過這個熱點再回家，比直接回家多繞的直線距離（km） */
  detourKm: number;
}

export interface HomeRoute {
  /** 順路熱點，依預期時薪排序；沒有順路的就是空的 */
  onRoute: HomeCandidate[];
  /** 要推薦的那一個：順路第一名；沒有順路的，退而求其次取多繞最少的熱點；完全沒資料才是 null */
  best: HomeCandidate | null;
  /** best 是不是真的順路（多繞 ≤ MAX_DETOUR_KM） */
  isOnRoute: boolean;
  homeKm: number;
  homeBearing: number;
}

const km = (a: LatLon, b: LatLon) => distanceM(a, b) / 1000;

export function detourKm(from: LatLon, via: LatLon, home: LatLon): number {
  return Math.max(0, km(from, via) + km(via, home) - km(from, home));
}

/** 從雷達推薦（範圍內＋範圍外的熱點）挑出順路回家的。不含原地：人是要往家裡走的 */
export function homeRoute(rec: Recommendation, from: LatLon, home: LatLon, maxDetour = MAX_DETOUR_KM): HomeRoute {
  const pool: HomeCandidate[] = [...rec.candidates, ...rec.far]
    .filter((c) => !c.here)
    .map((c) => ({ ...c, detourKm: detourKm(from, c.center, home) }));
  const onRoute = pool.filter((c) => c.detourKm <= maxDetour).sort((a, b) => b.score - a.score);
  // 沒有順路的熱點也不要空白：取多繞最少的那一個（同樣多繞取分數高的）
  const nearest = [...pool].sort((a, b) => a.detourKm - b.detourKm || b.score - a.score)[0] ?? null;
  return {
    onRoute,
    best: onRoute[0] ?? nearest,
    isOnRoute: onRoute.length > 0,
    homeKm: km(from, home),
    homeBearing: bearingDeg(from, home),
  };
}
