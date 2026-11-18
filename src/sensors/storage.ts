// 持久儲存（SPEC 3.4）：首次啟動就申請，設定頁顯示結果。
//
// Chrome Android 不會跳出詢問視窗，而是看條件自動決定：已安裝成 App（需要 Google Play
// 服務才能產生 WebAPK）、加入書籤、經常使用，或「網站已取得通知權限」。
// 這支手機可能沒有 Google 服務，所以提供用通知權限再申請一次的方式。

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

export type NotifyPermission = NotificationPermission | 'unsupported';

export const notificationPermission = (): NotifyPermission =>
  'Notification' in window ? Notification.permission : 'unsupported';

/** 先取得通知權限（Chrome 判斷可以持久儲存的條件之一），再申請一次持久儲存。 */
export async function retryPersistWithNotification(): Promise<{ persist: PersistState; notify: NotifyPermission }> {
  let notify = notificationPermission();
  if (notify === 'default') {
    try {
      notify = await Notification.requestPermission();
    } catch {
      notify = notificationPermission();
    }
  }
  return { persist: await ensurePersisted(), notify };
}

/** 是不是從主畫面圖示開啟（獨立視窗，沒有網址列） */
export const isStandalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
