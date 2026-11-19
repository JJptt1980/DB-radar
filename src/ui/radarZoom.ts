// 雷達縮放與光點合併（純函式，方便測試）。

/** 雷達最小範圍（公里） */
export const MIN_RANGE_KM = 0.5;

/** 角落按鈕的三段範圍：最大、一半、四分之一 */
export function zoomLevels(maxKm: number): number[] {
  return [maxKm, maxKm / 2, maxKm / 4];
}

/** 按一下角落按鈕：往下一段放大，已經是最大倍率就回到全範圍 */
export function nextZoom(currentKm: number, maxKm: number): number {
  const next = zoomLevels(maxKm).find((k) => k < currentKm / 1.05);
  return next ?? maxKm;
}

/** 目前範圍是第幾段（0 = 全範圍）；雙指縮放到中間值時取最接近的 */
export function zoomStage(currentKm: number, maxKm: number): number {
  const levels = zoomLevels(maxKm);
  let best = 0;
  levels.forEach((k, i) => {
    if (Math.abs(Math.log(k / currentKm)) < Math.abs(Math.log(levels[best]! / currentKm))) best = i;
  });
  return best;
}

export const clampRange = (km: number, maxKm: number): number => Math.min(maxKm, Math.max(MIN_RANGE_KM, km));

/** 好讀的刻度：0.1、0.2、0.25、0.5、1、2、2.5、5… 取不小於 x 的最小值 */
export function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x - 1e-9) return m * p;
  return 10 * p;
}

export interface Placed<T> {
  item: T;
  x: number;
  y: number;
  score: number;
}

export interface Cluster<T> {
  /** 這一群裡分數最高的點，位置就用它的（點過去就是最好的那格） */
  best: T;
  x: number;
  y: number;
  score: number;
  count: number;
}

/**
 * 螢幕上距離 radiusPx 以內的點合成一個：從分數最高的開始當中心，
 * 其他點加入第一個夠近的群。放大雷達時距離拉開，群會自然分開。
 */
export function clusterDots<T>(dots: readonly Placed<T>[], radiusPx: number): Cluster<T>[] {
  const out: Cluster<T>[] = [];
  for (const d of [...dots].sort((a, b) => b.score - a.score)) {
    const hit = out.find((c) => Math.hypot(c.x - d.x, c.y - d.y) <= radiusPx);
    if (hit) hit.count++;
    else out.push({ best: d.item, x: d.x, y: d.y, score: d.score, count: 1 });
  }
  return out;
}

/** 光點半徑：一個點 6px，點越多越大，最大 18px */
export const clusterRadius = (count: number): number => Math.min(18, 6 + 3 * Math.sqrt(count - 1));
