import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RecordPage } from './RecordPage';
import { SettingsPage } from './SettingsPage';
import { TABS, type TabId, parseTab } from './tabs';
import { useAppState } from './store';

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

  const theme = useAppState().settings.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const light = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f3f6f4' : '#05100a');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', light ? 'light' : 'dark');
  }, [theme]);

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
        ) : tab === 'radar' ? (
          <Lazy load={() => import('./RadarPage').then((m) => m.RadarPage)} />
        ) : (
          <Lazy load={() => import('./StatsPage').then((m) => m.StatsPage)} />
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

/** 雷達頁與統計頁用到 h3-js，等打開時才載入，首頁保持輕巧 */
function Lazy(props: { load: () => Promise<ComponentType> }) {
  const [Comp, setComp] = useState<ComponentType | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setComp(null);
    props
      .load()
      .then((c) => alive && setComp(() => c))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [props.load.toString()]);
  if (err) return <p class="muted">載入失敗，請確認網路後重新整理。</p>;
  return Comp ? <Comp /> : <p class="muted">載入中…</p>;
}
