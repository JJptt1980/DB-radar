// 時段切分（SPEC 4.1）：日型 × 小時 = 120 個槽位，一律用台北時間。

export type DayType = 'weekday' | 'fri' | 'sat' | 'sun' | 'holiday';
export const DAY_TYPES: readonly DayType[] = ['weekday', 'fri', 'sat', 'sun', 'holiday'];
export const DAY_LABEL: Record<DayType, string> = {
  weekday: '平日',
  fri: '週五',
  sat: '週六',
  sun: '週日',
  holiday: '國定假日',
};

export type Slot = `${DayType}:${number}`;

const HOUR = 3_600_000;
const TZ = 8 * HOUR;

export function taipeiParts(ts: number): { dow: number; hour: number; dateKey: string } {
  const d = new Date(ts + TZ);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    dateKey: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
  };
}

export function dayType(ts: number, holidays: ReadonlySet<string>): DayType {
  const { dow, dateKey } = taipeiParts(ts);
  if (holidays.has(dateKey)) return 'holiday';
  if (dow === 5) return 'fri';
  if (dow === 6) return 'sat';
  if (dow === 0) return 'sun';
  return 'weekday';
}

export function slotOf(ts: number, holidays: ReadonlySet<string>): Slot {
  return `${dayType(ts, holidays)}:${taipeiParts(ts).hour}`;
}

export function parseSlot(s: Slot): { day: DayType; hour: number } {
  const [day, h] = s.split(':') as [DayType, string];
  return { day, hour: Number(h) };
}

/** 同日型的前一小時與下一小時（0 點的前一小時是同日型的 23 點） */
export function adjacentSlots(s: Slot): [Slot, Slot] {
  const { day, hour } = parseSlot(s);
  return [`${day}:${(hour + 23) % 24}`, `${day}:${(hour + 1) % 24}`];
}

export type DayPart = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'midnight';

export const DAY_PART_LABEL: Record<DayPart, string> = {
  dawn: '凌晨',
  morning: '早上',
  noon: '中午',
  afternoon: '下午',
  evening: '晚上',
  midnight: '半夜',
};

/** 一天分六段：凌晨 2–4、早上 5–9、中午 10–12、下午 13–16、晚上 17–21、半夜 22–1 */
export function dayPart(hour: number): DayPart {
  if (hour >= 2 && hour <= 4) return 'dawn';
  if (hour >= 5 && hour <= 9) return 'morning';
  if (hour >= 10 && hour <= 12) return 'noon';
  if (hour >= 13 && hour <= 16) return 'afternoon';
  if (hour >= 17 && hour <= 21) return 'evening';
  return 'midnight';
}

export const slotHour = (s: Slot): number => parseSlot(s).hour;

export function slotLabel(s: Slot): string {
  const { day, hour } = parseSlot(s);
  return `${DAY_LABEL[day]} ${hour} 點`;
}

/** 下一個整點（台北與 UTC 差整數小時，所以整點邊界相同） */
export const nextHour = (ts: number): number => Math.floor(ts / HOUR) * HOUR + HOUR;
