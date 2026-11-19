// 方向（SPEC 3.2）：開車時用 GPS 行進方向；停下來時車頭不會自己轉，所以鎖住最後的車頭方向，
// 不理會 GPS 位置漂移和車內不準的指南針。還沒開過車（剛打開就停著）才用指南針，都沒有就北方朝上。
import { useEffect, useState } from 'preact/hooks';
import { bearingDeg, distanceM } from '../domain/geo';
import { lastFix, onFix, type Fix } from './gps';

export type HeadingSource = 'gps' | 'held' | 'compass' | null;

const FAST_MS = 15 / 3.6;
const STALE_MS = 3_000;
const SMOOTH = 0.25;
/** 慢速時，離上次定錨點至少這麼遠（且超過定位誤差兩倍）才用位移算方向；原地漂移通常在這之內 */
const SLOW_MOVE_M = 30;
/** 一次跳這麼遠表示 App 剛從背景回來、中間開過車，鎖住的方向已經不可信 */
const JUMP_M = 300;
/** 指南針變化小於這個角度就不轉，減少車內磁場干擾造成的抖動 */
const COMPASS_DEADBAND = 20;

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

/** 鎖住的車頭方向，以及算出它的位置（定錨點） */
export interface HeadingHold {
  deg: number;
  lat: number;
  lon: number;
}

/**
 * 每個 GPS 定位進來時決定車頭方向（純函式，方便測試）：
 * - 夠快且有 GPS heading：用它，定錨點移到這裡。
 * - 慢速：離定錨點夠遠（真的在移動，例如慢慢轉進巷子）才用位移方向；否則維持原本方向。
 * - 一次跳太遠：放棄鎖住的方向。
 */
export function nextHold(hold: HeadingHold | null, f: Pick<Fix, 'lat' | 'lon' | 'speed' | 'heading' | 'accuracy'>): HeadingHold | null {
  if (f.speed != null && f.speed >= FAST_MS && f.heading != null) {
    return { deg: smoothAngle(hold?.deg ?? null, f.heading), lat: f.lat, lon: f.lon };
  }
  if (!hold) return null;
  const d = distanceM(hold, f);
  if (d >= JUMP_M) return null;
  if (d > Math.max(SLOW_MOVE_M, 2 * (f.accuracy ?? 0))) {
    return { deg: smoothAngle(hold.deg, bearingDeg(hold, f), 0.5), lat: f.lat, lon: f.lon };
  }
  return hold;
}

/** 換頁、重開雷達都沿用同一個鎖住的方向 */
let sharedHold: HeadingHold | null = null;

/** 兩個角度相差幾度（0～180） */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function useHeading(): { deg: number | null; source: HeadingSource } {
  const [state, setState] = useState<{ deg: number | null; source: HeadingSource }>(() =>
    sharedHold ? { deg: sharedHold.deg, source: 'held' } : { deg: null, source: null },
  );

  useEffect(() => {
    let compass: number | null = null;
    let compassAt = 0;

    const onFixed = (f: Fix) => {
      const moving = f.speed != null && f.speed >= FAST_MS && f.heading != null;
      const next = nextHold(sharedHold, f);
      sharedHold = next;
      if (next) setState({ deg: next.deg, source: moving ? 'gps' : 'held' });
    };
    const offFix = onFix(onFixed);

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || sharedHold) return; // 有車頭方向就不理指南針
      const raw = compassFromAlpha(e.alpha, screen.orientation?.angle ?? 0);
      compassAt = Date.now();
      if (compass != null && angleDiff(compass, raw) < COMPASS_DEADBAND) return;
      compass = smoothAngle(compass, raw);
      setState({ deg: compass, source: 'compass' });
    };
    addEventListener('deviceorientationabsolute', onOrient as EventListener);

    // 沒有車頭方向、指南針也太久沒更新就改回北方朝上
    const timer = setInterval(() => {
      if (!sharedHold && compass != null && Date.now() - compassAt > STALE_MS) {
        compass = null;
        setState({ deg: null, source: null });
      }
    }, 1_000);

    const f = lastFix();
    if (f) onFixed(f);

    return () => {
      offFix();
      removeEventListener('deviceorientationabsolute', onOrient as EventListener);
      clearInterval(timer);
    };
  }, []);

  return state;
}
