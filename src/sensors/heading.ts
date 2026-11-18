// 方向（SPEC 3.2）：速度 ≥ 15 km/h 用 GPS 行進方向，較慢時用指南針，都沒有就北方朝上。
import { useEffect, useState } from 'preact/hooks';
import { lastFix, onFix } from './gps';

export type HeadingSource = 'gps' | 'compass' | null;

const FAST_MS = 15 / 3.6;
const STALE_MS = 3_000;
const SMOOTH = 0.25;

/** 角度的指數移動平均：用單位向量平均，避免 359° → 1° 時繞一大圈 */
export function smoothAngle(prev: number | null, next: number, k = SMOOTH): number {
  if (prev == null) return next;
  const r = Math.PI / 180;
  const x = (1 - k) * Math.cos(prev * r) + k * Math.cos(next * r);
  const y = (1 - k) * Math.sin(prev * r) + k * Math.sin(next * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/** deviceorientationabsolute 的 alpha（逆時針）換成羅盤方位，並修正螢幕旋轉 */
export function compassFromAlpha(alpha: number, screenAngle = 0): number {
  return (((360 - alpha + screenAngle) % 360) + 360) % 360;
}

export function useHeading(): { deg: number | null; source: HeadingSource } {
  const [state, setState] = useState<{ deg: number | null; source: HeadingSource }>({ deg: null, source: null });

  useEffect(() => {
    let smoothed: number | null = null;
    let gpsAt = 0;
    let compassAt = 0;
    let compass: number | null = null;
    let source: HeadingSource = null;

    const push = (raw: number, src: HeadingSource) => {
      smoothed = src === source ? smoothAngle(smoothed, raw) : raw;
      source = src;
      setState({ deg: smoothed, source });
    };

    const offFix = onFix((f) => {
      if (f.speed != null && f.speed >= FAST_MS && f.heading != null) {
        gpsAt = Date.now();
        push(f.heading, 'gps');
      }
    });

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha == null) return;
      compass = compassFromAlpha(e.alpha, screen.orientation?.angle ?? 0);
      compassAt = Date.now();
      if (Date.now() - gpsAt > STALE_MS) push(compass, 'compass');
    };
    addEventListener('deviceorientationabsolute', onOrient as EventListener);

    // 兩種來源都太久沒更新就改回北方朝上
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - gpsAt > STALE_MS && now - compassAt > STALE_MS && source !== null) {
        source = null;
        smoothed = null;
        setState({ deg: null, source: null });
      }
    }, 1_000);

    const f = lastFix();
    if (f?.speed != null && f.speed >= FAST_MS && f.heading != null) push(f.heading, 'gps');

    return () => {
      offFix();
      removeEventListener('deviceorientationabsolute', onOrient as EventListener);
      clearInterval(timer);
    };
  }, []);

  return state;
}
