// App 狀態：從 IndexedDB 載入事件與車資，處理按鈕、復原、GPS 補位置與軌跡記錄。
import { useEffect, useState } from 'preact/hooks';
import {
  addTrackPoint,
  getAllEvents,
  getAllFares,
  getSettings,
  lastTrackPoint,
  putEvent,
  putFare,
  uuid,
} from '../db/db';
import { DEFAULT_SETTINGS, type BackupMeta, type DeclineReason, type EventType, type Fare, type Settings, type TripEvent } from '../db/types';
import { currentStatus, transition, type CurrentStatus } from '../domain/state';
import { shouldRecordTrack } from '../domain/geo';
import { freshFix, lastFix, onFix, startGps, stopGps } from '../sensors/gps';
import {
  ensurePersisted,
  retryPersistWithNotification,
  type NotifyPermission,
  type PersistState,
} from '../sensors/storage';
import { autoBackup, backupNow, clientIdFrom, onMeta, resumeOnStart } from '../backup/sync';
import { hasToken } from '../backup/drive';

export const UNDO_MS = 10_000;
export const DECLINE_PROMPT_MS = 5_000;

export interface AppState {
  loaded: boolean;
  events: TripEvent[];
  fares: Map<string, Fare>;
  settings: Settings;
  status: CurrentStatus;
  persist: PersistState | null;
  /** 最近一次按鈕事件，10 秒內可復原 */
  undo: { eventId: string; label: string; at: number } | null;
  /** 拒單後 5 秒的快速理由按鈕 */
  declinePrompt: { eventId: string; at: number } | null;
  /** 正在填哪一筆下客的車資 */
  fareFormFor: string | null;
  backup: BackupMeta | null;
  /** 記錄頁上方的短訊息（例如「已備份到 Google Drive」） */
  notice: { text: string; at: number; bad?: boolean } | null;
}

let state: AppState = {
  loaded: false,
  events: [],
  fares: new Map(),
  settings: DEFAULT_SETTINGS,
  status: { state: 'offline', shiftId: null, since: null },
  persist: null,
  undo: null,
  declinePrompt: null,
  fareFormFor: null,
  backup: null,
  notice: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  if (patch.events) state.status = currentStatus(state.events);
  listeners.forEach((l) => l());
}

export const getState = (): AppState => state;

export function useAppState(): AppState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

function replaceEvent(e: TripEvent) {
  const events = state.events.filter((x) => x.id !== e.id);
  events.push(e);
  set({ events });
}

function replaceFare(f: Fare) {
  const fares = new Map(state.fares);
  fares.set(f.id, f);
  set({ fares });
}

export async function loadAll(): Promise<void> {
  const [events, fares, settings] = await Promise.all([getAllEvents(), getAllFares(), getSettings()]);
  set({ loaded: true, events, fares: new Map(fares.map((f) => [f.id, f])), settings });
}

let tracking = false;
let lastTrack: { ts: number; lat: number; lon: number } | null = null;

/** 啟動時呼叫一次：載入資料、申請持久儲存、開始定位與軌跡記錄。 */
export async function init(): Promise<void> {
  await loadAll();
  lastTrack = await lastTrackPoint();
  void ensurePersisted().then((persist) => set({ persist }));
  onMeta((backup) => set({ backup }));
  void resumeOnStart(clientId());
  addEventListener('online', () => {
    // 有網路了：如果還有待備份、而且權杖還有效，就安靜補做（不跳登入畫面）
    if (state.backup?.pending && hasToken()) void backupNow(clientId(), false).catch(() => undefined);
  });
  startGps();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startGps();
    else stopGps();
  });
  onFix((fix) => {
    const { state: s, shiftId } = state.status;
    if (s === 'offline' || !shiftId || tracking) return;
    if (!shouldRecordTrack(lastTrack, fix, state.settings.trackIntervalSec)) return;
    tracking = true;
    const point = { id: uuid(), shiftId, ...fix, updatedAt: Date.now() };
    lastTrack = point;
    void addTrackPoint(point).finally(() => {
      tracking = false;
    });
  });
}

export const clientId = (): string => clientIdFrom(state.settings.googleClientId);

export function notify(text: string, bad = false): void {
  set({ notice: { text, at: Date.now(), bad } });
}

/** 使用者點「現在備份」：可以跳出 Google 登入 */
export async function backupByUser(): Promise<void> {
  try {
    const r = await backupNow(clientId(), true);
    notify(`已備份到 Google Drive（${r.name}）`);
  } catch (e) {
    notify(`備份失敗：${e instanceof Error ? e.message : String(e)}`, true);
  }
}

export async function retryPersist(): Promise<NotifyPermission> {
  const r = await retryPersistWithNotification();
  set({ persist: r.persist });
  return r.notify;
}

/** 兩次按鈕至少間隔多久。下一顆主按鈕會出現在同一個位置，避免連點直接記到下一步。 */
export const PRESS_COOLDOWN_MS = 800;
let pressing = false;
let lastPressAt = 0;

export async function press(type: EventType): Promise<void> {
  const now = Date.now();
  if (pressing || now - lastPressAt < PRESS_COOLDOWN_MS) return;
  const { state: s, shiftId } = state.status;
  if (!transition(s, type)) return;
  pressing = true;
  lastPressAt = now;
  let ev: TripEvent;
  try {
    ev = await recordPress(type, s === 'offline' ? null : shiftId, now);
  } finally {
    pressing = false;
  }
  await refineLocation(ev, now);
}

async function recordPress(type: EventType, shiftId: string | null, now: number): Promise<TripEvent> {
  const fix = lastFix();
  const ev: TripEvent = {
    id: uuid(),
    shiftId: type === 'online' ? uuid() : (shiftId ?? uuid()),
    type,
    ts: now,
    lat: fix?.lat ?? null,
    lon: fix?.lon ?? null,
    accuracy: fix?.accuracy ?? null,
    source: 'button',
    updatedAt: now,
  };
  if (type === 'offer_declined') ev.declineReason = null;
  await putEvent(ev);
  replaceEvent(ev);

  const patch: Partial<AppState> = { undo: { eventId: ev.id, label: type, at: now } };
  if (type === 'offer_declined') patch.declinePrompt = { eventId: ev.id, at: now };
  if (type === 'dropoff' && state.settings.askFare) {
    const fare: Fare = { id: ev.id, fare: null, surge: null, tip: null, note: '', pending: true, updatedAt: now };
    await putFare(fare);
    replaceFare(fare);
    patch.fareFormFor = ev.id;
  }
  set(patch);
  if (type === 'offline') {
    void autoBackup(clientId()).then((r) => {
      if (r === 'done') notify('已自動備份到 Google Drive');
      else if (r === 'pending') notify('這一班還沒備份到 Google Drive，有網路時點「現在備份」', true);
    });
  }
  return ev;
}

/** 先用最後已知位置寫入，再等新定位補上（逾時就保留舊值）。 */
async function refineLocation(ev: TripEvent, now: number): Promise<void> {
  const fresh = await freshFix(now);
  if (!fresh) return;
  const cur = state.events.find((e) => e.id === ev.id);
  if (!cur || cur.deleted || cur.source === 'manual_edit') return; // 已被復原或手動改過（補拒單理由不影響）
  const updated: TripEvent = {
    ...cur,
    lat: fresh.lat,
    lon: fresh.lon,
    accuracy: fresh.accuracy,
    updatedAt: Date.now(),
  };
  await putEvent(updated);
  replaceEvent(updated);
}

export async function undoLast(): Promise<void> {
  const u = state.undo;
  if (!u || Date.now() - u.at > UNDO_MS) return;
  const ev = state.events.find((e) => e.id === u.eventId);
  set({ undo: null, declinePrompt: null, fareFormFor: state.fareFormFor === u.eventId ? null : state.fareFormFor });
  if (!ev) return;
  await deleteEvent(ev.id);
}

export async function setDeclineReason(eventId: string, reason: DeclineReason): Promise<void> {
  const ev = state.events.find((e) => e.id === eventId);
  set({ declinePrompt: null });
  if (!ev) return;
  const updated = { ...ev, declineReason: reason, updatedAt: Date.now() };
  await putEvent(updated);
  replaceEvent(updated);
}

export function dismissDeclinePrompt(): void {
  set({ declinePrompt: null });
}

export function openFareForm(eventId: string | null): void {
  set({ fareFormFor: eventId });
}

export async function saveFare(f: Omit<Fare, 'updatedAt'>): Promise<void> {
  const fare: Fare = { ...f, updatedAt: Date.now() };
  await putFare(fare);
  replaceFare(fare);
  set({ fareFormFor: null });
}

export async function updateEvent(e: TripEvent): Promise<void> {
  const updated: TripEvent = { ...e, source: 'manual_edit', updatedAt: Date.now() };
  await putEvent(updated);
  replaceEvent(updated);
}

/** 軟刪除事件；下客事件的車資一起軟刪除。 */
export async function deleteEvent(id: string): Promise<void> {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const now = Date.now();
  const updated = { ...ev, deleted: true, updatedAt: now };
  await putEvent(updated);
  replaceEvent(updated);
  const fare = state.fares.get(id);
  if (fare && !fare.deleted) {
    const f = { ...fare, deleted: true, updatedAt: now };
    await putFare(f);
    replaceFare(f);
  }
}
