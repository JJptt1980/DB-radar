// Uber 台灣的計價公式（SPEC 7.2.1）。費率取自使用者 Uber 官方資料裡最近的行程（2026-11），
// 每趟都記錄了基本費、每英里、每分鐘與最低車資；換成每公里後就是下表。
import { distanceM } from '../domain/geo';

export type FareRegion = 'taoyuan' | 'taipei';
export type Product = 'standard' | 'comfort' | 'comfort_electric' | 'black' | 'pet';

export const PRODUCT_LABEL: Record<Product, string> = {
  standard: '標準',
  comfort: 'Comfort',
  comfort_electric: 'Comfort 電動',
  black: 'Black',
  pet: '寵物',
};

export const REGION_LABEL: Record<FareRegion, string> = { taoyuan: '桃園', taipei: '北北基' };

export interface RateCard {
  base: number;
  perKm: number;
  perMin: number;
  minimum: number;
}

/**
 * 乘客車資（不含訂車費、不含加成）的費率。
 * 桃園 Comfort 電動、寵物，以及北北基 Comfort、Comfort 電動的最低車資資料裡沒有出現，依同區標準車的比例推估。
 */
export const RATES: Record<FareRegion, Record<Product, RateCard>> = {
  taoyuan: {
    standard: { base: 59, perKm: 25, perMin: 1.7, minimum: 90 },
    comfort: { base: 71, perKm: 30, perMin: 2.0, minimum: 108 },
    comfort_electric: { base: 83, perKm: 35, perMin: 2.4, minimum: 126 },
    black: { base: 89, perKm: 37.5, perMin: 2.6, minimum: 135 },
    pet: { base: 99, perKm: 25, perMin: 1.7, minimum: 130 },
  },
  taipei: {
    standard: { base: 48, perKm: 25, perMin: 3.4, minimum: 85 },
    comfort: { base: 58, perKm: 30, perMin: 4.1, minimum: 102 },
    comfort_electric: { base: 67, perKm: 35, perMin: 4.8, minimum: 119 },
    black: { base: 72, perKm: 37.5, perMin: 5.1, minimum: 128 },
    pet: { base: 88, perKm: 25, perMin: 3.4, minimum: 125 },
  },
};

/** Uber 抽成 */
export const SERVICE_FEE = 0.25;

/** 司機實收：乘客車資 ×（1 − 服務費），四捨五入（.5 往下，和官方資料一致） */
export function driverEarnings(region: FareRegion, product: Product, km: number, minutes: number, surge = 1): number {
  const r = RATES[region][product];
  const fare = Math.max(r.minimum, (r.base + r.perKm * km + r.perMin * minutes) * surge);
  const x = fare * (1 - SERVICE_FEE);
  return Math.ceil(x - 0.5);
}

/** 桃園市的粗略邊界（[lat, lon]），只用來分辨該套用桃園還是北北基費率 */
const TAOYUAN: [number, number][] = [
  [25.13, 121.24],
  [25.1, 121.33],
  [25.06, 121.37],
  [25.01, 121.41],
  [24.93, 121.33],
  [24.85, 121.36],
  [24.62, 121.45],
  [24.6, 121.25],
  [24.75, 121.1],
  [24.85, 121.02],
  [24.98, 120.98],
  [25.07, 121.1],
];

function inPolygon(lat: number, lon: number, poly: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!;
    const [yj, xj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 桃園市內用桃園費率；北邊、東邊的雙北與基隆用北北基費率；其他地方（新竹以南）先用桃園 */
export function regionAt(lat: number, lon: number): FareRegion {
  if (inPolygon(lat, lon, TAOYUAN)) return 'taoyuan';
  return lon > 121.3 && lat > 24.8 ? 'taipei' : 'taoyuan';
}

/** 一段時間內軌跡走過的公里數（取樣有間隔，乘 1.05 補回彎道）；點太少回傳 null */
export function trackKm(points: readonly { ts: number; lat: number; lon: number }[], from: number, to: number): number | null {
  const pts = points.filter((p) => p.ts >= from && p.ts <= to).sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distanceM(pts[i - 1]!, pts[i]!);
  return (m / 1000) * 1.05;
}
