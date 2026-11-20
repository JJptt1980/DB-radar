#!/usr/bin/env python3
"""行程影片匯入器（SPEC 第 8 章）

用法：python3 tools/video-import/run.py <影片.mp4> [--out 輸出.json] [--no-geocode] [--check 樣本.json]

流程：ffmpeg 抽畫面 → ocr.swift（Apple Vision）→ 卡片解析與投票 → 檢核 → geocode.swift → 匯出 JSON。
只用標準函式庫。工作目錄（畫面、OCR 結果、地理編碼快取）在 ~/DB-radar-import。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import parse  # noqa: E402

WORK = Path.home() / 'DB-radar-import'
BIN = WORK / 'bin'
GEOCACHE = WORK / 'geocache.json'
FPS = 4
# 以 1080×2400 為準：上面去掉系統狀態列，下面去掉 Uber 自己的分頁列（會蓋住清單最後一行）
CROP_TOP, CROP_BOTTOM, REF_H = 100, 2180, 2400
KEYCHAIN_SERVICE = 'db-radar-google-geocoding'


def die(msg: str) -> None:
    print(f'錯誤：{msg}', file=sys.stderr)
    sys.exit(1)


def need(cmd: str, hint: str) -> None:
    if not shutil.which(cmd):
        die(f'找不到 {cmd}，{hint}')


def build_swift(name: str) -> Path:
    """編譯 swift 小程式並快取，原始檔有改才重新編譯。"""
    src = HERE / f'{name}.swift'
    out = BIN / name
    if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
        BIN.mkdir(parents=True, exist_ok=True)
        print(f'編譯 {name}.swift …')
        subprocess.run(['swiftc', '-O', str(src), '-o', str(out)], check=True)
    return out


def probe(video: Path) -> tuple[int, int]:
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
         '-of', 'csv=p=0', str(video)],
        capture_output=True, text=True, check=True,
    )
    w, h = r.stdout.strip().split(',')[:2]
    return int(w), int(h)


def extract_frames(video: Path, frames: Path) -> list[Path]:
    w, h = probe(video)
    top = round(CROP_TOP * h / REF_H)
    bottom = round(CROP_BOTTOM * h / REF_H)
    ch = (bottom - top) // 2 * 2
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'fps={FPS},mpdecimate,crop={w}:{ch}:0:{top}',
         '-fps_mode', 'vfr', str(frames / 'f_%04d.png')],
        check=True,
    )
    return sorted(frames.glob('f_*.png'))


def run_ocr(frames: list[Path], out: Path) -> list[dict]:
    ocr = build_swift('ocr')
    with out.open('w') as f:
        subprocess.run([str(ocr), str(FPS), *map(str, frames)], stdout=f, check=True)
    return [json.loads(l) for l in out.read_text().splitlines() if l.strip()]


# ---------- 地理編碼 ----------

# Apple 的地理編碼只認地址，不認地標（「桃園國際機場」會落在桃園市區），常見地標直接給座標
KNOWN_POI = [
    (re.compile(r'Terminal\s*1|第一航廈'), 'Taoyuan International Airport|桃園.*機場', (25.0800, 121.2337)),
    (re.compile(r'Terminal\s*2|第二航廈'), 'Taoyuan International Airport|桃園.*機場', (25.0772, 121.2323)),
    (re.compile(r'High Speed Rail|高鐵桃園站|HSR'), 'Taoyuan|桃園', (25.0129, 121.2150)),
]
MAX_FROM_DISTRICT_KM = 8


def known_poi(addr: str) -> list[float] | None:
    for pat, ctx, pt in KNOWN_POI:
        if pat.search(addr) and re.search(ctx, addr):
            return [pt[0], pt[1]]
    return None


def km(a: list[float], b: list[float]) -> float:
    import math
    dy = (a[0] - b[0]) * 111.2
    dx = (a[1] - b[1]) * 111.2 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)

def geo_normalize(addr: str) -> str:
    """全形轉半形、去掉台灣與郵遞區號、英文區名換中文（8.3 步驟 6）。這也是快取的鍵。"""
    a = unicodedata.normalize('NFKC', addr)
    for en, zh in parse.EN_DISTRICTS.items():
        a = a.replace(en, zh)
    a = a.replace('Taoyuan City', '桃園市')
    a = re.sub(r',?\s*(台灣|Taiwan)\s*\d{0,6}\s*$', '', a)
    a = re.sub(r'^台灣', '', a)
    a = re.sub(r'\s+', ' ', a).strip(' ,')
    return a


def geo_candidates(addr: str) -> list[str]:
    """由詳細到粗略的查詢字串，第一個查得到的就用。"""
    n = geo_normalize(addr)
    out = [n]
    if ', ' in n:
        parts = [p for p in n.split(', ') if p]
        admin = [p for p in parts if re.fullmatch(r'[一-鿿]{1,3}[市區]', p)]
        local = [re.sub(r'\s*\([^)]*\)', '', p) for p in parts if p not in admin]
        city = ''.join(reversed(admin))
        out.append(city + ' '.join(local))
        out.append(' '.join(reversed(local)))  # 例：Taoyuan International Airport Terminal 2
    m = re.match(r'^(.*?[市])?(.*?[區])?', n)
    if m and (m.group(1) or m.group(2)):
        out.append((m.group(1) or '') + (m.group(2) or ''))
    seen, uniq = set(), []
    for q in out:
        if q and q not in seen:
            seen.add(q)
            uniq.append(q)
    return uniq


def google_key() -> str | None:
    r = subprocess.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], capture_output=True, text=True)
    return r.stdout.strip() or None if r.returncode == 0 else None


def google_geocode(queries: list[str], key: str) -> dict[str, list[float] | None]:
    out = {}
    for q in queries:
        url = 'https://maps.googleapis.com/maps/api/geocode/json?' + urllib.parse.urlencode(
            {'address': q, 'region': 'tw', 'language': 'zh-TW', 'key': key})
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                d = json.load(r)
            loc = d['results'][0]['geometry']['location'] if d.get('results') else None
            out[q] = [loc['lat'], loc['lng']] if loc else None
        except Exception as e:  # 網路錯誤就當作查不到
            print(f'Google 查詢失敗：{q}（{e}）', file=sys.stderr)
            out[q] = None
    return out


def geocode_trips(trips: list[dict]) -> None:
    cache: dict[str, list[float] | None] = json.loads(GEOCACHE.read_text()) if GEOCACHE.exists() else {}
    addrs = {t[k] for t in trips for k in ('pickupAddress', 'dropoffAddress') if t[k] and not known_poi(t[k])}
    cands = {a: geo_candidates(a) for a in addrs}
    # 每個區的中心點，用來擋掉離譜的結果
    district_q = {a: '桃園市' + parse.district_of(a) for a in addrs if parse.district_of(a)}
    for q in set(district_q.values()):
        cands.setdefault('@' + q, [q])

    def pending():
        out = []
        for a, qs in cands.items():
            for q in qs:
                if q not in cache:
                    out.append(q)
                    break
                if cache[q]:
                    break
        return out

    geocoder = build_swift('geocode')
    # 一次查一輪（每個地址目前最詳細、還沒查過的那個），查不到再退一步
    for _ in range(4):
        todo = sorted(set(pending()))
        if not todo:
            break
        print(f'地理編碼：查詢 {len(todo)} 筆（Apple）…')
        r = subprocess.run([str(geocoder)], input=json.dumps(todo), capture_output=True, text=True)
        res = json.loads(r.stdout or '{}')
        missing = [q for q in todo if not res.get(q)]
        key = google_key() if missing else None
        if key:
            print(f'Apple 查不到 {len(missing)} 筆，改用 Google …')
            res.update({q: v for q, v in google_geocode(missing, key).items() if v})
        for q in todo:
            cache[q] = res.get(q)
        GEOCACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))

    def plausible(a: str, pt: list[float]) -> bool:
        center = cache.get(district_q.get(a, ''))
        return not center or km(pt, center) <= MAX_FROM_DISTRICT_KM

    for t in trips:
        for side in ('pickup', 'dropoff'):
            a = t[f'{side}Address']
            hit = known_poi(a) or next(
                (cache[q] for q in cands.get(a, []) if cache.get(q) and plausible(a, cache[q])), None)
            if hit:
                t[f'{side}Lat'], t[f'{side}Lon'] = round(hit[0], 6), round(hit[1], 6)


def road_of(addr: str) -> str | None:
    a = geo_normalize(addr)
    m = re.search(r'([一-鿿]+?(?:路|街|大道)(?:[一二三四五六七八九十]+段)?)$', re.sub(r'^.*[市區里村]', '', a))
    return m.group(1) if m else None


def share_neighbor_points(trips: list[dict]) -> int:
    """鄰趟校正：上一趟下車、下一趟上車在同一條路、空檔 5 分鐘內，共用同一個座標。"""
    n = 0
    for prev, cur in zip(trips, trips[1:]):
        g = cur['raw']['gapBeforeMin']
        if not g or float(g) > 5:
            continue
        r1, r2 = road_of(prev['dropoffAddress'] or ''), road_of(cur['pickupAddress'] or '')
        if r1 and r1 == r2 and prev['dropoffLat'] is not None:
            cur['pickupLat'], cur['pickupLon'] = prev['dropoffLat'], prev['dropoffLon']
            n += 1
    return n


# ---------- 輸出 ----------

def print_summary(trips: list[dict], warns: list[str]) -> None:
    print()
    print(f'{"#":>2}  開始   車資  加成  車型          時長    公里   上車 → 下車')
    for i, t in enumerate(trips, 1):
        d = t['durationSec']
        print(f'{i:>2}  {t["raw"]["startLocal"]}  {t["fare"]:>4}  {t["surge"]:>4}  {t["product"]:<10}  '
              f'{d // 60:>2}:{d % 60:02d}  {t["distanceKm"]:>5.2f}  {t["pickupAddress"]} → {t["dropoffAddress"]}'
              f'{"  ⚠ 只讀到 1 次" if t["lowSupport"] else ""}')
    total = sum(t['fare'] for t in trips)
    surge = sum(t['surge'] for t in trips)
    print()
    print(f'合計 {len(trips)} 趟，車資 ${total:,}（已含加成 ${surge:,}，基本車資 ${total - surge:,}）')
    print('請和 Uber App 的當日或當週總收入對照。')
    gaps = sorted(float(t['raw']['gapBeforeMin']) for t in trips if t['raw']['gapBeforeMin'])
    if gaps:
        mid = gaps[len(gaps) // 2] if len(gaps) % 2 else (gaps[len(gaps) // 2 - 1] + gaps[len(gaps) // 2]) / 2
        print(f'空檔 {len(gaps)} 個：中位數 {mid:.1f} 分鐘，合計 {sum(gaps):.1f} 分鐘')
    prec = {}
    for t in trips:
        for k in ('pickupPrecision', 'dropoffPrecision'):
            prec[t[k]] = prec.get(t[k], 0) + 1
    print('地點精度：' + '、'.join(f'{k} {v}' for k, v in sorted(prec.items(), key=lambda x: -x[1])))
    if warns:
        print()
        print('需要確認：')
        for w in warns:
            print(f'  ⚠ {w}')


VOLATILE = {'pickupLat', 'pickupLon', 'dropoffLat', 'dropoffLon', 'updatedAt'}


def check_against(out: dict, fixture: Path) -> int:
    want = json.loads(fixture.read_text())
    diffs = []
    for k in ('app', 'kind', 'schemaVersion', 'sourceVideo'):
        if want.get(k) != out.get(k):
            diffs.append(f'{k}：應為 {want.get(k)!r}，得到 {out.get(k)!r}')
    got = {t['id']: t for t in out['importedTrips']}
    for t in want['importedTrips']:
        g = got.pop(t['id'], None)
        if not g:
            diffs.append(f'少了 {t["dedupeKey"]}')
            continue
        for k, v in t.items():
            if k not in VOLATILE and g.get(k) != v:
                diffs.append(f'{t["dedupeKey"]} {k}：應為 {v!r}，得到 {g.get(k)!r}')
    diffs += [f'多了 {t["dedupeKey"]}' for t in got.values()]
    print()
    if diffs:
        print(f'和 {fixture.name} 比對：{len(diffs)} 處不同')
        for d in diffs:
            print('  ✗ ' + d)
        return 1
    print(f'和 {fixture.name} 比對：全部一致（經緯度與時間戳記不比）')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description='把 Uber「行程費用紀錄」的螢幕錄影轉成 DB-radar 匯入檔')
    ap.add_argument('video', type=Path)
    ap.add_argument('--out', type=Path, help='輸出檔（預設 ~/DB-radar-import/radar-video-YYYYMMDD.json）')
    ap.add_argument('--year', type=int, help='檔名看不出年份時指定')
    ap.add_argument('--no-geocode', action='store_true', help='不查經緯度')
    ap.add_argument('--check', type=Path, help='和驗收樣本比對（經緯度與時間戳記除外）')
    ap.add_argument('--keep-frames', action='store_true', help='保留抽出來的畫面')
    a = ap.parse_args()

    video = a.video.expanduser().resolve()
    if not video.exists():
        die(f'找不到影片：{video}')
    need('ffmpeg', '請先安裝：brew install ffmpeg')
    need('swiftc', '請先安裝 Xcode Command Line Tools：xcode-select --install')

    m = re.search(r'(\d{4})(\d{2})(\d{2})', video.name)
    year = a.year or (int(m.group(1)) if m else time.localtime(video.stat().st_mtime).tm_year)
    stamp = m.group(0) if m else time.strftime('%Y%m%d', time.localtime(video.stat().st_mtime))

    WORK.mkdir(parents=True, exist_ok=True)
    frames_dir = WORK / f'frames-{video.stem}'
    t0 = time.time()
    frames = extract_frames(video, frames_dir)
    print(f'抽出 {len(frames)} 張畫面，OCR 中 …')
    ocr = run_ocr(frames, WORK / f'ocr-{video.stem}.jsonl')
    if not a.keep_frames:
        shutil.rmtree(frames_dir, ignore_errors=True)

    observations, saw_end = [], False
    list_frames = 0
    overlay = parse.find_overlay(ocr)
    if overlay:
        print(f'偵測到畫面右側固定不動的浮窗（y = {overlay[0]}～{overlay[1]}），附近的右欄文字不採用')
    for f in ocr:
        obs, end = parse.parse_frame(f, year, overlay)
        if parse.is_list_frame(parse.to_lines(f)):
            list_frames += 1
        observations += obs
        saw_end = saw_end or end
    print(f'OCR 完成（{time.time() - t0:.0f} 秒）：{list_frames} 張是行程清單，讀到 {len(observations)} 次卡片')
    if not observations:
        die('沒有讀到任何行程卡片。請確認錄的是 Uber「行程費用紀錄」頁面。')

    now_ms = int(time.time() * 1000)
    trips = parse.build_trips(observations, year, now_ms)
    warns = parse.validate(trips)
    if not saw_end:
        warns.append('沒有看到「…之間的活動結束」，清單可能沒有滑到底，最後幾趟可能漏掉')

    if not a.no_geocode:
        geocode_trips(trips)
        shared = share_neighbor_points(trips)
        if shared:
            print(f'鄰趟校正：{shared} 個上車點和前一趟下車點共用座標')
        nogeo = sum(1 for t in trips for s in ('pickup', 'dropoff') if t[f'{s}Lat'] is None)
        if nogeo:
            warns.append(f'{nogeo} 個地點查不到經緯度，匯入後只用在時段統計')

    print_summary(trips, warns)

    out = {
        'app': 'db-radar',
        'kind': 'video-import',
        'schemaVersion': 2,
        'exportedAt': now_ms,
        'sourceVideo': video.name,
        'importedTrips': trips,
    }
    path = (a.out or WORK / f'radar-video-{stamp}.json').expanduser()
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(f'\n已輸出：{path}')
    print('把這個檔案傳到手機，在 DB-radar 設定頁 →「行程影片匯入」選它。')

    if a.check:
        return check_against(out, a.check.expanduser())
    return 0


if __name__ == '__main__':
    sys.exit(main())
