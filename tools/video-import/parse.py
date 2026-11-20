"""行程卡片解析、跨畫面投票、檢核（SPEC 8.3 步驟 3～5、8.5）。只用標準函式庫。"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))

RE_FARE = re.compile(r'^\$\s*([\d,]+\.\d{2})$')
RE_DATE = re.compile(r'(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*週')
RE_TIME = re.compile(r'(上午|下午)\s*(\d{1,2})\s*[:：]\s*(\d{2})')
RE_CLOCK = re.compile(r'^(\d{1,2})\s*[:：]\s*(\d{2})$')
RE_SPEC = re.compile(
    r'^(.+?)\s*[·•・.]?\s*(\d+)\s*分鐘\s*(\d+)\s*秒\s*[·•・.]?\s*(\d+(?:\.\d+)?)\s*公\s*里'
)
RE_SURGE = re.compile(r'\$\s*([\d,]+\.\d{2})\s*加成計費')
RE_END = re.compile(r'之間的活動結束')
RE_LIST_PAGE = re.compile(r'行程費用紀錄')

MAP_BLACKLIST = re.compile(r'^Google|Map data|©')

EN_DISTRICTS = {
    'Taoyuan District': '桃園區', 'Zhongli District': '中壢區', 'Bade District': '八德區',
    'Dayuan District': '大園區', 'Luzhu District': '蘆竹區', 'Guishan District': '龜山區',
    'Pingzhen District': '平鎮區', 'Yangmei District': '楊梅區', 'Daxi District': '大溪區',
    'Longtan District': '龍潭區', 'Xinwu District': '新屋區', 'Guanyin District': '觀音區',
    'Fuxing District': '復興區',
}


@dataclass
class Line:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int

    @property
    def bottom(self) -> int:
        return self.y + self.h


@dataclass
class Observation:
    """某一張畫面讀到的一張完整卡片"""
    frame: str
    date: tuple[int, int]
    start: str            # HH:mm（24 小時制）
    fare: float
    surge: float
    product: str
    duration_sec: int
    distance_km: float
    pickup: str
    dropoff: str
    conf: dict[str, float] = field(default_factory=dict)


def nfkc(s: str) -> str:
    return unicodedata.normalize('NFKC', s)


def clean_address(s: str) -> str:
    """OCR 的地址統一格式：全形標點轉半形、逗號後一個空格、郵遞區號前空格。"""
    s = nfkc(s)
    s = re.sub(r'\s*,\s*', ', ', s)
    s = re.sub(r'\s*\(\s*', ' (', s)
    s = re.sub(r'\s*\)', ')', s)
    s = re.sub(r'\s+', ' ', s).strip().strip(',').strip()
    if ', ' in s:
        s = re.sub(r'台灣\s*(\d{3,6})\b', r'台灣 \1', s)
    s = re.sub(r'^\(', '(', s)
    return s


RE_ICON = re.compile(r'^[^\w\u4e00-\u9fff(]+')
RE_ADDRESSY = re.compile(r'台灣|Taiwan|[市區里村路街巷]|District|City|Village|Airport|Terminal|Road|Street')


def strip_icon(s: str) -> str:
    """去掉 OCR 讀進來的圖釘符號（例：「？台灣…」「。 台灣…」「• 台灣…」）"""
    return RE_ICON.sub('', s).strip()


def to_lines(frame: dict) -> list[Line]:
    out = []
    for l in frame['lines']:
        x, y, w, h = l['bbox']
        out.append(Line(l['text'], float(l['conf']), x, y, w, h))
    out.sort(key=lambda l: (l.y, l.x))
    return out


def is_list_frame(lines: list[Line]) -> bool:
    text = ' '.join(l.text for l in lines)
    return bool(RE_LIST_PAGE.search(text) or RE_DATE.search(nfkc(text)))


def to24(ampm: str, h: int, m: int) -> str:
    if ampm == '上午':
        h = 0 if h == 12 else h
    else:
        h = h if h == 12 else h + 12
    return f'{h:02d}:{m:02d}'


def line_finished(l: Line, width: int) -> bool:
    """這一行地址看起來已經結束（中文或郵遞區號結尾、沒被右緣切掉）。"""
    text = strip_icon(nfkc(l.text))
    if re.search(r'(台灣|Taiwan)\s*\d{0,6}\s*\(?$', text):
        return True  # 國名和郵遞區號一定在地址最後，就算郵遞區號被切掉也算結束
    clipped = bool(width) and l.x + l.w >= width - CLIP_MARGIN
    return not clipped and bool(re.search(r'(\d{3,6}\)?|[\u4e00-\u9fff])$', text))


def has_icon(l: Line) -> bool:
    return bool(RE_ICON.match(nfkc(l.text)))


def group_address_blocks(lines: list[Line], width: int = 0) -> list[list[Line]]:
    """英文地址會折成兩行。上一行還沒結束（逗號或英文字結尾、被右緣切掉）、
    下一行前面沒有圖釘符號、而且行距夠近，才合併成同一段。"""
    blocks: list[list[Line]] = []
    for l in lines:
        if blocks:
            prev = blocks[-1][-1]
            close = (l.y - prev.y) < 1.6 * max(prev.h, l.h)
            if not line_finished(prev, width) and not has_icon(l) and close and l.x <= prev.x + 80:
                blocks[-1].append(l)
                continue
        blocks.append([l])
    return blocks


# 桃園市各區郵遞區號：Uber 的地址太長時會被畫面右緣切掉（例：「台灣 33(」），用區名補回
POSTAL = {
    '桃園區': '330', '中壢區': '320', '平鎮區': '324', '八德區': '334', '楊梅區': '326', '蘆竹區': '338',
    '大溪區': '335', '龜山區': '333', '大園區': '337', '觀音區': '328', '新屋區': '327', '龍潭區': '325',
    '復興區': '336',
}
# 英文地址行尾被切掉時用來補字（只補最後一個被切斷的字）
EN_WORDS = ['City', 'District', 'Village', 'Taiwan', 'Taoyuan', 'International', 'Airport', 'Road', 'Street', 'Section']
CLIP_MARGIN = 60  # 文字右緣離畫面右緣這麼近，就當作被切掉


def repair_clipped_line(text: str, clipped: bool, has_next: bool) -> str:
    if not clipped:
        return text
    m = re.search(r'([A-Za-z]{2,})$', text)
    if m:
        frag = m.group(1)
        for w in EN_WORDS:
            if w != frag and w.startswith(frag):
                text = text[: m.start()] + w
                if has_next and w in ('City', 'District', 'Village', 'Road', 'Street'):
                    text += ','
                break
    return text


def repair_postal(addr: str) -> str:
    """「…, 桃園區, 桃園市, 台灣 33(」→「…, 台灣 330」"""
    m = re.search(r'台灣\s*(\d{0,5})\s*\(?$', addr)
    if not m or ', ' not in addr or len(m.group(1)) in (3, 6):
        return addr
    code = POSTAL.get(district_of(addr), '')
    return (addr[: m.start()] + ('台灣 ' + code if code else '台灣')).strip()


def join_block(block: list[Line], width: int = 0) -> str:
    parts = [
        repair_clipped_line(
            strip_icon(nfkc(l.text)), bool(width) and l.x + l.w >= width - CLIP_MARGIN, i < len(block) - 1
        )
        for i, l in enumerate(block)
    ]
    s = parts[0]
    for p in parts[1:]:
        s = s + ' ' + p if re.search(r'[A-Za-z0-9,)]$', s) or re.match(r'[A-Za-z(]', p) else s + p
    return repair_postal(clean_address(s))


def address_fully_visible(blocks: list[list[Line]], width: int, height: int) -> bool:
    """畫面最下面那張卡片的下車地址是否完整。

    Vision 的框會被畫面邊緣截齊，所以貼著底邊的行要看高度：比上車地址的行矮很多就是被切掉了。
    最後一行如果還沒結束（英文地址會折行），下面還得放得下一整行。
    """
    last = blocks[-1][-1]
    ref_h = blocks[0][0].h
    if last.bottom > height - 6 and last.h < 0.85 * ref_h:
        return False
    return line_finished(last, width) or last.bottom + 1.2 * last.h <= height


def find_overlay(frames: list[dict], min_share: float = 0.4, min_count: int = 20) -> tuple[int, int] | None:
    """找出右欄固定不動的浮窗（例如手機的電流／溫度監測），回傳它的上下緣 y。

    清單會捲動，卡片上的字不會一直停在同一個位置；同樣的字、同樣的位置出現在四成以上（而且至少 20 張）
    的清單畫面，就是疊在畫面上的浮窗。日期標題列也固定，所以排除；影片結尾停住時卡片的時間會連續好幾張
    不動，所以時間樣子的字也排除。
    """
    seen: Counter = Counter()
    boxes: dict[tuple, Line] = {}
    n = 0
    for f in frames:
        lines = to_lines(f)
        if not is_list_frame(lines):
            continue
        n += 1
        for l in lines:
            t = nfkc(l.text)
            if l.x < f['width'] * 0.8 or RE_DATE.search(t) or RE_CLOCK.match(t) or re.search(r'上午|下午', t):
                continue
            key = (l.text, round(l.x / 20), round(l.y / 20))
            seen[key] += 1
            boxes[key] = l
    fixed = [boxes[k] for k, c in seen.items() if c >= min_count and c >= n * min_share]
    if not fixed:
        return None
    return min(l.y for l in fixed), max(l.bottom for l in fixed)


def parse_frame(frame: dict, year: int, overlay: tuple[int, int] | None = None) -> tuple[list[Observation], bool]:
    """回傳這張畫面裡的完整卡片，以及是否看到清單結束。"""
    lines = to_lines(frame)
    if not is_list_frame(lines):
        return [], False
    width = frame['width']
    right_x = width * 0.8
    if overlay:
        # 浮窗上下一行高內的右欄文字不可靠（OCR 會把時間和浮窗的字黏在一起，例：「11:23.5」「9:0②」）
        top_y, bottom_y = overlay[0] - 60, overlay[1] + 60
        lines = [l for l in lines if not (l.x >= right_x and l.bottom > top_y and l.y < bottom_y)]

    # 日期標題與分隔列：(y, (月, 日))
    dates = []
    for l in lines:
        m = RE_DATE.search(nfkc(l.text))
        if m:
            dates.append((l.y, (int(m.group(1)), int(m.group(2)))))
    end_y = next((l.y for l in lines if RE_END.search(l.text)), None)

    starts = [i for i, l in enumerate(lines) if RE_FARE.match(nfkc(l.text).replace(' ', '')) and l.x < width * 0.5]
    obs: list[Observation] = []
    for k, si in enumerate(starts):
        nxt = starts[k + 1] if k + 1 < len(starts) else None
        stop_y = lines[nxt].y if nxt is not None else end_y
        bounded = stop_y is not None
        card = [l for l in lines[si:] if stop_y is None or l.y < stop_y]
        # 畫面最下面那張：只有在地圖標記之後兩段地址都完整、而且離畫面底部還有空間時才採用
        o = parse_card(card, dates, year, right_x, frame['frame'], bounded, frame['height'], width)
        if o:
            obs.append(o)
    return obs, end_y is not None


def parse_card(
    card: list[Line], dates, year: int, right_x: float, frame_name: str, bounded: bool = True, height: int = 0,
    width: int = 0,
) -> Observation | None:
    head = card[0]
    fare = float(RE_FARE.match(nfkc(head.text).replace(' ', '')).group(1).replace(',', ''))
    date = None
    for y, d in dates:
        if y < head.y:
            date = d
    if not date:
        return None

    map_idx = next((i for i, l in enumerate(card) if re.search(r'[MW]ap data', l.text)), None)
    if map_idx is None and not bounded:
        return None
    map_y = card[map_idx].y if map_idx is not None else head.y + 6 * head.h
    top = [l for l in card[1:] if l.y < map_y]

    # 時間：右欄接起來找，找不到再找左欄（例：「4.20 公 上午 9:05」）
    start = None
    right = ' '.join(nfkc(l.text) for l in top + [head] if l.x >= right_x and l.y < head.y + 6 * head.h)
    right_sorted = ' '.join(
        nfkc(l.text) for l in sorted([l for l in [head] + top if l.x >= right_x], key=lambda l: l.y)
        if l.y < head.y + 6 * head.h
    )
    for src in (right_sorted, right):
        m = RE_TIME.search(src)
        if m:
            start = to24(m.group(1), int(m.group(2)), int(m.group(3)))
            break
    left_top = [l for l in top if l.x < right_x and not (l.w < 70 and l.x < 130)]
    if not start:
        for l in left_top:
            m = RE_TIME.search(nfkc(l.text))
            if m:
                start = to24(m.group(1), int(m.group(2)), int(m.group(3)))
                break
    if not start:
        return None

    # 車型・時長・距離：卡片第 2～3 行（去掉時間文字）
    spec_lines = [l for l in left_top if l.y < head.y + 5 * head.h and not RE_SURGE.search(nfkc(l.text))]
    spec_text = ' '.join(RE_TIME.sub('', nfkc(l.text)) for l in spec_lines)
    spec_text = re.sub(r'\s+', ' ', spec_text).strip()
    m = RE_SPEC.match(spec_text)
    if not m:
        return None
    product = re.sub(r'[\s·•・.]+$', '', m.group(1)).strip()
    # 浮窗的字黏到時間後面、掉進車型（例：「A 標準型優步」「8% 標準型優步」）
    product = re.sub(r'^[A-Za-z0-9%]{1,3}\s*(?=[一-鿿])', '', product)
    duration = int(m.group(2)) * 60 + int(m.group(3))
    distance = float(m.group(4))

    surge = 0.0
    for l in top:
        ms = RE_SURGE.search(nfkc(l.text).replace(' ', ''))
        if ms:
            surge = float(ms.group(1).replace(',', ''))

    spec_bottom = max(l.bottom for l in spec_lines)
    after = card[map_idx + 1:] if map_idx is not None else [l for l in card if l.y > spec_bottom]
    addr_lines = [
        l for l in after
        if l.x < right_x * 0.3 and l.w >= 70 and not MAP_BLACKLIST.search(l.text)
    ]
    blocks = [b for b in group_address_blocks(addr_lines, width) if RE_ADDRESSY.search(join_block(b))]
    if map_idx is not None:
        blocks = blocks[:2]
    else:
        blocks = blocks[-2:]  # 沒讀到地圖標記：地圖上的地名在上面，最後兩段才是地址
    if len(blocks) < 2:
        return None
    if not bounded and not address_fully_visible(blocks, width, height):
        return None
    pickup, dropoff = join_block(blocks[0], width), join_block(blocks[1], width)

    def conf(ls):
        return sum(l.conf for l in ls) / len(ls)

    return Observation(
        frame=frame_name,
        date=date,
        start=start,
        fare=fare,
        surge=surge,
        product=product,
        duration_sec=duration,
        distance_km=distance,
        pickup=pickup,
        dropoff=dropoff,
        conf={'head': head.conf, 'spec': conf(spec_lines), 'pickup': conf(blocks[0]), 'dropoff': conf(blocks[1])},
    )


def vote(values: list, confs: list[float]):
    c = Counter(values)
    best = max(c.values())
    tied = [v for v, n in c.items() if n == best]
    if len(tied) == 1:
        return tied[0]
    score = defaultdict(float)
    for v, cf in zip(values, confs):
        if v in tied:
            score[v] += cf
    return max(tied, key=lambda v: score[v])


def district_of(addr: str) -> str:
    for en, zh in EN_DISTRICTS.items():
        if en in addr:
            return zh
    if ', ' in addr:
        for part in addr.split(', '):
            if re.fullmatch(r'[\u4e00-\u9fff]{1,3}區', part):
                return part
    m = re.search(r'([一-鿿]{1,3}區)', re.sub(r'^.*?市', '', addr))
    return m.group(1) if m else ''


def precision_of(addr: str) -> str:
    a = nfkc(addr)
    if re.search(r'\d+\s*號', a):
        return 'address'
    if re.search(r'巷|弄|Lane|Alley', a):
        return 'lane'
    if re.search(r'機場|航廈|車站|醫院|Airport|Terminal|Station|Hospital', a):
        return 'poi'
    if re.search(r'路|街|大道|Road|Rd\.?\b|Street|St\.?\b|Avenue|Blvd', a):
        return 'street'
    if re.search(r'里|村|Village', a):
        return 'village'
    return 'district'


def dedupe_key(date: str, start: str, fare: float, distance: float) -> str:
    return f'{date}|{start}|{fare:g}|{distance:.2f}'


def build_trips(observations: list[Observation], year: int, now_ms: int) -> list[dict]:
    """同一趟跨畫面投票，回傳 ImportedTrip。

    同一趟的判斷：同日、同開始時間；或同日、車資＋時長＋公里都一樣、時間差 30 分鐘內。
    後者是因為時間在右欄，被手機上的浮窗（例如電流監測）蓋到時會讀錯（11:11 → 11:23.5）。
    """
    parent = list(range(len(observations)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def minutes(o: Observation) -> int:
        hh, mm = map(int, o.start.split(':'))
        return hh * 60 + mm

    by_time: dict[tuple, int] = {}
    by_spec: dict[tuple, list[int]] = defaultdict(list)
    for i, o in enumerate(observations):
        j = by_time.setdefault((o.date, o.start), i)
        parent[find(i)] = find(j)
        spec = (o.date, o.fare, o.duration_sec, o.distance_km)
        for j in by_spec[spec]:
            if abs(minutes(observations[j]) - minutes(o)) <= 30:
                parent[find(i)] = find(j)
        by_spec[spec].append(i)

    groups: dict[int, list[Observation]] = defaultdict(list)
    for i, o in enumerate(observations):
        groups[find(i)].append(o)

    trips = []
    for obs in groups.values():
        date = obs[0].date
        month, day = date
        date_str = f'{year:04d}-{month:02d}-{day:02d}'
        hc = [o.conf['head'] for o in obs]
        sc = [o.conf['spec'] for o in obs]
        start = vote([o.start for o in obs], hc)
        fare = vote([o.fare for o in obs], hc)
        surge = vote([o.surge for o in obs], sc)
        product = vote([o.product for o in obs], sc)
        duration = vote([o.duration_sec for o in obs], sc)
        distance = vote([o.distance_km for o in obs], sc)
        pickup = vote([o.pickup for o in obs], [o.conf['pickup'] for o in obs])
        dropoff = vote([o.dropoff for o in obs], [o.conf['dropoff'] for o in obs])
        hh, mm = map(int, start.split(':'))
        # 卡片上的時間是接單時間（2026-11-19 對照 Uber 官方資料確認，不是上客時間）
        request_ts = int(datetime(year, month, day, hh, mm, tzinfo=TAIPEI).timestamp() * 1000)
        key = dedupe_key(date_str, start, fare, distance)
        trips.append({
            'id': 'vid_' + hashlib.sha1(key.encode()).hexdigest()[:12],
            'source': 'video',
            'externalId': None,
            'dedupeKey': key,
            'requestTs': request_ts,
            # 上客、下客時間影片看不出來（接駁時間未知），App 匯入 Uber 官方資料後會補上
            'pickupTs': None,
            'dropoffTs': None,
            'durationSec': duration,
            'distanceKm': distance,
            'pickupLat': None,
            'pickupLon': None,
            'dropoffLat': None,
            'dropoffLon': None,
            'pickupAddress': pickup,
            'dropoffAddress': dropoff,
            'pickupPrecision': precision_of(pickup),
            'dropoffPrecision': precision_of(dropoff),
            'fare': int(fare) if fare == int(fare) else fare,
            'surge': int(surge) if surge == int(surge) else surge,
            'product': product,
            'lowSupport': len(obs) < 2,
            'matchedDropoffEventId': None,
            'raw': {
                'pickupDistrict': district_of(pickup),
                'dropoffDistrict': district_of(dropoff),
                'startLocal': start,
                'gapBeforeMin': '',
            },
            'updatedAt': now_ms,
        })

    trips.sort(key=lambda t: t['requestTs'])
    # 空檔（8.5）：同一天才算，保留一位小數
    for prev, cur in zip(trips, trips[1:]):
        if prev['dedupeKey'][:10] == cur['dedupeKey'][:10]:
            # 空檔 = 這一趟接單 −（上一趟接單 ＋ 行程時長）；上一趟的接駁時間未知，所以會略為高估
            gap = (cur['requestTs'] - (prev['requestTs'] + prev['durationSec'] * 1000)) / 60000
            cur['raw']['gapBeforeMin'] = f'{round(gap + 1e-9, 1):.1f}'
    return trips


def validate(trips: list[dict], gap_break_min: float = 45) -> list[str]:
    """檢核（8.3 步驟 5），回傳警告訊息。"""
    warns = []
    for t in trips:
        label = f"{t['raw']['startLocal']} ${t['fare']}"
        if t['durationSec'] <= 0 or t['distanceKm'] <= 0:
            warns.append(f'{label}：時長或距離不是正數')
        elif not 3 <= t['distanceKm'] / (t['durationSec'] / 3600) <= 90:
            warns.append(f'{label}：平均時速 {t["distanceKm"] / (t["durationSec"] / 3600):.0f} km/h 不合理')
        if t['fare'] < t['surge']:
            warns.append(f'{label}：加成大於車資')
        g = t['raw']['gapBeforeMin']
        if g and float(g) < 0:
            warns.append(f'{label}：和上一趟的空檔是負的（{g} 分鐘），時間或時長可能讀錯')
        if t['lowSupport']:
            warns.append(f'{label}：只在 1 張畫面讀到，請確認')
    return warns
