import { useEffect, useState } from 'preact/hooks';
import { RecordPage } from './RecordPage';
import { SettingsPage } from './SettingsPage';
import { TABS, type TabId, parseTab } from './tabs';

export function App() {
  const [tab, setTab] = useState<TabId>(() => parseTab(location.hash));
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const onHash = () => setTab(parseTab(location.hash));
    const onNet = () => setOnline(navigator.onLine);
    addEventListener('hashchange', onHash);
    addEventListener('online', onNet);
    addEventListener('offline', onNet);
    return () => {
      removeEventListener('hashchange', onHash);
      removeEventListener('online', onNet);
      removeEventListener('offline', onNet);
    };
  }, []);

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div class="app">
      <header class="topbar">
        <h1>{current.label}</h1>
        {!online && <span class="badge">離線中</span>}
      </header>
      <main class="page">
        {tab === 'record' ? (
          <RecordPage />
        ) : tab === 'settings' ? (
          <SettingsPage />
        ) : (
          <section class="placeholder">
            <div class="placeholder-icon" aria-hidden="true">
              {current.icon}
            </div>
            <p class="placeholder-title">{current.label}頁</p>
            <p class="placeholder-note">{current.note}</p>
          </section>
        )}
      </main>
      <nav class="tabbar" aria-label="主要分頁">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            class={t.id === tab ? 'tab active' : 'tab'}
            aria-current={t.id === tab ? 'page' : undefined}
          >
            <span class="tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span class="tab-label">{t.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
