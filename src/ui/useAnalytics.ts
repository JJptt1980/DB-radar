// 雷達頁與統計頁共用的統計結果：依「資料版本」快取，資料沒變就不重算（SPEC 4.7）。
import { useEffect, useState } from 'preact/hooks';
import { buildStats, type StatsIndex } from '../analytics/stats';
import { countTrackPoints, getAllImportedTrips, getAllTracks } from '../db/db';
import { useAppState } from './store';

let cache: { key: string; index: StatsIndex } | null = null;

export function useAnalytics(): { index: StatsIndex | null; loading: boolean } {
  const app = useAppState();
  const [, force] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lastUpdate = app.events.reduce((m, e) => Math.max(m, e.updatedAt), 0);
      const fareUpdate = [...app.fares.values()].reduce((m, f) => Math.max(m, f.updatedAt), 0);
      const [tracks, imported] = await Promise.all([countTrackPoints(), getAllImportedTrips()]);
      const s = app.settings;
      const key = [app.events.length, lastUpdate, app.fares.size, fareUpdate, tracks, imported.length,
        s.h3Res, s.holidays.join(), s.fareIncludesSurge, s.gapBreakMin, s.importWeight].join('|');
      if (cache?.key === key) return force((n) => n + 1);
      setLoading(true);
      const all = await getAllTracks();
      if (cancelled) return;
      const index = buildStats({ events: app.events, fares: app.fares, tracks: all, imported, settings: s });
      cache = { key, index };
      setLoading(false);
      force((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.events, app.fares, app.settings]);

  return { index: cache?.index ?? null, loading };
}
