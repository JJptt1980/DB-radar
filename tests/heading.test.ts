import { describe, expect, it } from 'vitest';
import { compassFromAlpha, smoothAngle } from '../src/sensors/heading';
import { bearingDeg, compassLabel } from '../src/domain/geo';

describe('方向', () => {
  it('角度平滑不會在 0/360 之間繞遠路', () => {
    const s = smoothAngle(350, 10, 0.5);
    expect(s < 5 || s > 355).toBe(true);
    expect(smoothAngle(null, 123)).toBe(123);
  });
  it('alpha 換成羅盤方位', () => {
    expect(compassFromAlpha(0)).toBe(0);
    expect(compassFromAlpha(90)).toBe(270); // alpha 逆時針 90° = 面向西
    expect(compassFromAlpha(90, 90)).toBe(0);
  });
  it('方位角與中文方向', () => {
    const a = { lat: 25, lon: 121.5 };
    expect(Math.round(bearingDeg(a, { lat: 25.01, lon: 121.5 }))).toBe(0);
    expect(Math.round(bearingDeg(a, { lat: 25, lon: 121.51 }))).toBe(90);
    expect(compassLabel(44)).toBe('東北');
    expect(compassLabel(350)).toBe('北');
    expect(compassLabel(225)).toBe('西南');
  });
});

import { angleDiff, nextHold } from '../src/sensors/heading';

describe('停車鎖定車頭方向', () => {
  const base = { lat: 25.0, lon: 121.5 }; // 虛構座標
  const north = (m: number) => ({ lat: base.lat + m / 111_195, lon: base.lon });
  const east = (m: number) => ({ lat: base.lat, lon: base.lon + m / (111_195 * Math.cos((25 * Math.PI) / 180)) });

  it('開車時用 GPS 方向，停下後原地漂移不改方向', () => {
    let h = nextHold(null, { ...base, speed: 10, heading: 90, accuracy: 5 });
    expect(h!.deg).toBe(90);
    // 停車，位置在 20 公尺內亂飄、GPS heading 亂跳
    for (const p of [north(12), east(-15), north(-8)]) h = nextHold(h, { ...p, speed: 0.3, heading: 200, accuracy: 10 });
    expect(h!.deg).toBe(90);
  });

  it('定位誤差大時漂移門檻跟著放大', () => {
    const h = nextHold({ deg: 90, ...base }, { ...north(45), speed: 0.5, heading: null, accuracy: 30 });
    expect(h!.deg).toBe(90);
  });

  it('慢慢開動（例如轉進巷子）時用位移方向', () => {
    const h = nextHold({ deg: 90, ...base }, { ...north(50), speed: 2, heading: null, accuracy: 5 });
    expect(angleDiff(h!.deg, 45)).toBeLessThan(1); // 東（90）和北（0）各半
    expect(h!.lat).toBeCloseTo(north(50).lat);
  });

  it('一次跳太遠（App 從背景回來）就放棄鎖定；沒開過車也不亂猜', () => {
    expect(nextHold({ deg: 90, ...base }, { ...north(500), speed: 0, heading: null, accuracy: 5 })).toBeNull();
    expect(nextHold(null, { ...base, speed: 0, heading: 120, accuracy: 5 })).toBeNull();
  });

  it('angleDiff 跨過 0 度', () => {
    expect(angleDiff(350, 10)).toBe(20);
  });
});
