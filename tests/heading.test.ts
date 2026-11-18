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
