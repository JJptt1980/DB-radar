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

export function slotLabel(s: Slot): string {
  const { day, hour } = parseSlot(s);
  return `${DAY_LABEL[day]} ${hour} 點`;
}

/** 下一個整點（台北與 UTC 差整數小時，所以整點邊界相同） */
export const nextHour = (ts: number): number => Math.floor(ts / HOUR) * HOUR + HOUR;
