// 事件狀態機與推導（SPEC 2.3、2.4）。全部是純函式。
import type { EventType, Fare, TripEvent } from '../db/types';

export type DriverState = 'offline' | 'idle' | 'enroute' | 'ontrip';

export const STATE_LABEL: Record<DriverState, string> = {
  offline: '已下線',
  idle: '空車中',
  enroute: '前往接客',
  ontrip: '載客中',
};

export const EVENT_LABEL: Record<EventType, string> = {
  online: '上線',
  accept: '接單',
  pickup: '上客',
  dropoff: '下客',
  cancel: '取消',
  offer_declined: '拒單',
  offline: '下線',
};

const TRANSITIONS: Record<DriverState, Partial<Record<EventType, DriverState>>> = {
  offline: { online: 'idle' },
  idle: { accept: 'enroute', offline: 'offline', offer_declined: 'idle' },
  enroute: { pickup: 'ontrip', cancel: 'idle' },
  ontrip: { dropoff: 'idle' },
};

/** 目前狀態按下某按鈕後的新狀態；不允許時回傳 null。 */
export function transition(state: DriverState, type: EventType): DriverState | null {
  return TRANSITIONS[state][type] ?? null;
}

/** 目前狀態可以按的按鈕，依畫面顯示順序（主要動作在前）。 */
export function allowedActions(state: DriverState): EventType[] {
  switch (state) {
    case 'offline':
      return ['online'];
    case 'idle':
      return ['accept', 'offer_declined', 'offline'];
    case 'enroute':
      return ['pickup', 'cancel'];
    case 'ontrip':
      return ['dropoff'];
  }
}

/** 事件本身代表的「發生後狀態」。用最後一筆事件還原，就算中間被編輯過也不會卡住。 */
export function stateAfter(type: EventType): DriverState {
  switch (type) {
    case 'online':
    case 'dropoff':
    case 'cancel':
    case 'offer_declined':
      return 'idle';
    case 'accept':
      return 'enroute';
    case 'pickup':
      return 'ontrip';
    case 'offline':
      return 'offline';
  }
}

export function liveEvents(events: readonly TripEvent[]): TripEvent[] {
  return events.filter((e) => !e.deleted).sort((a, b) => a.ts - b.ts || a.updatedAt - b.updatedAt);
}

export interface CurrentStatus {
  state: DriverState;
  shiftId: string | null;
  /** 進入目前狀態的時間（拒單不算狀態改變） */
  since: number | null;
}

export function currentStatus(events: readonly TripEvent[]): CurrentStatus {
  const live = liveEvents(events);
  const last = live[live.length - 1];
  if (!last) return { state: 'offline', shiftId: null, since: null };
  const state = stateAfter(last.type);
  let since = last.ts;
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i]!;
    if (e.type === 'offer_declined') continue;
    since = e.ts;
    break;
  }
  return { state, shiftId: state === 'offline' ? null : last.shiftId, since };
}

export interface Segment {
  kind: 'idle' | 'approach' | 'trip';
  start: TripEvent;
  end: TripEvent | null; // null = 還在進行中
  /** 空車段以下線結束（等了沒等到單），計算接單率時是截尾資料 */
  censored: boolean;
}

/** 推導空車段、接駁段、行程（SPEC 2.4）。 */
export function deriveSegments(events: readonly TripEvent[]): Segment[] {
  const out: Segment[] = [];
  let open: Segment | null = null;
  const close = (end: TripEvent, censored = false) => {
    if (open) {
      open.end = end;
      open.censored = censored;
      out.push(open);
      open = null;
    }
  };
  for (const e of liveEvents(events)) {
    switch (e.type) {
      case 'online':
      case 'dropoff':
      case 'cancel':
        close(e);
        open = { kind: 'idle', start: e, end: null, censored: false };
        break;
      case 'accept':
        close(e);
        open = { kind: 'approach', start: e, end: null, censored: false };
        break;
      case 'pickup':
        close(e);
        open = { kind: 'trip', start: e, end: null, censored: false };
        break;
      case 'offline':
        close(e, (open as Segment | null)?.kind === 'idle');
        break;
      case 'offer_declined':
        break;
    }
  }
  if (open) out.push(open);
  return out;
}

export interface ShiftSummary {
  trips: number;
  earnings: number;
  /** 還沒有車資的趟數（沒填、也還沒從官方資料補上） */
  unpriced: number;
  onlineMs: number;
  hourly: number | null;
}

/** 本班累計：趟數、實收（車資＋小費；車資已含加成）、時薪。 */
export function shiftSummary(
  events: readonly TripEvent[],
  fares: ReadonlyMap<string, Fare>,
  shiftId: string,
  now: number,
): ShiftSummary {
  const shift = liveEvents(events).filter((e) => e.shiftId === shiftId);
  let trips = 0;
  let earnings = 0;
  let unpriced = 0;
  for (const e of shift) {
    if (e.type !== 'dropoff') continue;
    trips++;
    const f = fares.get(e.id);
    if (f && !f.deleted && f.fare != null) earnings += f.fare + (f.tip ?? 0);
    else unpriced++;
  }
  const start = shift.find((e) => e.type === 'online')?.ts ?? shift[0]?.ts ?? now;
  const endEvt = shift.find((e) => e.type === 'offline');
  const onlineMs = Math.max(0, (endEvt?.ts ?? now) - start);
  const hours = onlineMs / 3_600_000;
  return { trips, earnings, unpriced, onlineMs, hourly: hours >= 0.05 ? Math.round(earnings / hours) : null };
}
