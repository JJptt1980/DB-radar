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
    <div class={tab === 'radar' ? 'app fit' : 'app'}>
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
              <TabIcon id={t.id} />
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

/** 分頁列的線條圖示（1.8px 線寬，跟著文字顏色） */
function TabIcon(props: { id: TabId }) {
  const common = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
  switch (props.id) {
    case 'record':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'radar':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 12 18 6" />
        </svg>
      );
    case 'stats':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M5 19V11M12 19V5M19 19v-5" />
        </svg>
      );
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </svg>
      );
  }
}
