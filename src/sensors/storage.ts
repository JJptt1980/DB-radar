// 持久儲存（SPEC 3.4）：首次啟動就申請，設定頁顯示結果。

export type PersistState = 'granted' | 'denied' | 'unsupported';

export async function ensurePersisted(): Promise<PersistState> {
  if (!navigator.storage?.persist) return 'unsupported';
  try {
    if (await navigator.storage.persisted()) return 'granted';
    return (await navigator.storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
