export type TabId = 'record' | 'radar' | 'stats' | 'settings';

export interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  note: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'record', label: '記錄', icon: '●', note: 'Phase 1 會在這裡放上線、接單、上客、下客的大按鈕。' },
  { id: 'radar', label: '雷達', icon: '◎', note: 'Phase 3 會在這裡顯示熱點雷達。' },
  { id: 'stats', label: '統計', icon: '▤', note: 'Phase 3 會在這裡顯示時段與地點排行。' },
  { id: 'settings', label: '設定', icon: '⚙', note: '之後會在這裡放備份、匯入與各項設定。' },
];

export function parseTab(hash: string): TabId {
  const id = hash.replace(/^#/, '');
  return TABS.some((t) => t.id === id) ? (id as TabId) : 'record';
}
