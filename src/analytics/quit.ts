// 收工建議（SPEC 4.5.2）：這小時和接下來幾小時的預估時薪，跟自己的平均比。純函式。
import type { Settings } from '../db/types';
import { nextHour, slotOf, taipeiParts } from './slots';
import type { StatsIndex } from './stats';
import { averageHourly, slotHourly } from './summary';

const HOUR = 3_600_000;
/** 低於平均的 90% 才算偏淡，避免在平均附近來回跳 */
export const WEAK_RATIO = 0.9;
/** 看這小時加接下來幾小時 */
export const AHEAD = 5;
/** 偏淡時，往後找幾小時有沒有回溫 */
export const RECOVER_WITHIN = 3;

export interface QuitHour {
  /** 台北時間幾點 */
  hour: number;
  /** 預估時薪；資料不足為 null */
  hourly: number | null;
}

/** keep 值得繼續；wait 偏淡但等等會回溫；quit 可以收工；better/worse 後面資料不足，只比這小時 */
export type QuitVerdict = 'keep' | 'wait' | 'quit' | 'better' | 'worse';

export interface QuitAdvice {
  verdict: QuitVerdict;
  /** 自己的平均預估時薪 */
  avg: number;
  hours: QuitHour[];
  /** 記錄頁用的一句話 */
  text: string;
  /** 雷達頁用的短句 */
  short: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString('zh-TW')}`;

export function quitAdvice(index: StatsIndex, settings: Settings, now: number): QuitAdvice | null {
  const avg = averageHourly(index, settings);
  if (avg == null) return null;
  const holidays = new Set(settings.holidays);
  const times = [now, ...Array.from({ length: AHEAD }, (_, i) => nextHour(now) + i * HOUR)];
  const hours: QuitHour[] = times.map((ts) => ({
    hour: taipeiParts(ts).hour,
    hourly: slotHourly(index, settings, slotOf(ts, holidays))?.hourly ?? null,
  }));
  const cur = hours[0]!.hourly;
  if (cur == null) return null;
  const good = (h: QuitHour) => h.hourly != null && h.hourly >= avg * WEAK_RATIO;
  const weak = (h: QuitHour) => h.hourly != null && h.hourly < avg * WEAK_RATIO;
  const vs = `這小時預估 ${money(cur)}/時，平常 ${money(avg)}`;
  const base = { avg, hours };

  if (good(hours[0]!)) {
    const i = hours.findIndex((h, k) => k > 0 && !good(h));
    if (i < 0) return { ...base, verdict: 'keep', text: `${vs}，接下來幾小時都不錯，繼續跑`, short: '值得繼續跑・接下來都不錯' };
    const h = hours[i]!;
    if (h.hourly == null) return { ...base, verdict: 'better', text: `${vs}，值得繼續跑`, short: '值得繼續跑' };
    return {
      ...base,
      verdict: 'keep',
      text: `${vs}，值得繼續；${h.hour} 點後掉到 ${money(h.hourly)}，可以跑到 ${h.hour} 點收工`,
      short: `值得繼續・跑到 ${h.hour} 點收工`,
    };
  }

  const next = hours.slice(1, 1 + RECOVER_WITHIN);
  const back = next.find(good);
  if (back) {
    return {
      ...base,
      verdict: 'wait',
      text: `${vs}，現在偏淡；${back.hour} 點回到 ${money(back.hourly!)}，撐得住可以再等`,
      short: `現在偏淡・${back.hour} 點回溫`,
    };
  }
  if (next.every(weak)) {
    return { ...base, verdict: 'quit', text: `${vs}，接下來 ${RECOVER_WITHIN} 小時都偏淡，可以收工了`, short: '可以收工了・接下來都偏淡' };
  }
  return { ...base, verdict: 'worse', text: `${vs}，現在偏淡`, short: '現在偏淡' };
}
