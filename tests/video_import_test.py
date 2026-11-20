"""行程影片匯入器的解析規則（用虛構的地址，不含真實行程）。執行：python3 -m unittest discover -s tests -p '*_test.py'"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools' / 'video-import'))
import parse  # noqa: E402

W, H = 1080, 2080


def line(text, x, y, w=600, h=52, conf=1.0):
    return {'text': text, 'conf': conf, 'bbox': [x, y, w, h]}


def frame(lines, name='f_0001.png'):
    return {'frame': name, 'tSec': 0, 'width': W, 'height': H, 'lines': lines}


def card(y, fare='$150.00', time_text='上午 9:05', spec='標準型優步 · 12分鐘30秒 · 4.20 公里',
         pickup='台灣桃園市虛構區測試一路', dropoff='台灣桃園市虛構區範例二街', surge=None):
    out = [
        line(fare, 177, y, 230, 66),
        line(time_text, 850, y + 80, 200, 52),
        line(spec, 181, y + 85, 640, 52),
    ]
    if surge:
        out.append(line(f'{surge} 加成計費', 70, y + 170, 360, 52))
    out += [
        line('Google', 45, y + 450, 170, 60),
        line('Map data ©2026 Google', 706, y + 480, 336, 32),
        line(pickup, 89, y + 545, 700, 52),
        line(dropoff, 89, y + 635, 700, 52),
    ]
    return out


HEADER = [line('11月18日週三', 76, 215, 326, 45)]


class ParseTest(unittest.TestCase):
    def test_basic_card(self):
        f = frame(HEADER + card(400) + [line('$99.00', 177, 1300, 200, 66)])
        obs, end = parse.parse_frame(f, 2026)
        self.assertFalse(end)
        self.assertEqual(len(obs), 1)
        o = obs[0]
        self.assertEqual((o.date, o.start, o.fare, o.surge), ((11, 18), '09:05', 150.0, 0.0))
        self.assertEqual((o.product, o.duration_sec, o.distance_km), ('標準型優步', 750, 4.2))
        self.assertEqual(o.pickup, '台灣桃園市虛構區測試一路')

    def test_time_at_end_of_second_line_and_surge(self):
        lines = card(400, time_text='', spec='Electric•17分鐘51 秒•4.20公上午 9:05', surge='$40.00')
        lines = [l for l in lines if l['text']] + [line('里', 181, 400 + 140, 48, 44)]  # 「公里」被拆成兩行
        f = frame(HEADER + lines + [line('2026年11月18日 之間的活動結束', 130, 1300, 800, 60)])
        obs, end = parse.parse_frame(f, 2026)
        self.assertTrue(end)
        self.assertEqual((obs[0].start, obs[0].product, obs[0].distance_km, obs[0].surge),
                         ('09:05', 'Electric', 4.2, 40.0))

    def test_pm_conversion(self):
        self.assertEqual(parse.to24('下午', 12, 5), '12:05')
        self.assertEqual(parse.to24('下午', 1, 5), '13:05')
        self.assertEqual(parse.to24('上午', 12, 30), '00:30')

    def test_card_cut_at_bottom_is_dropped(self):
        f = frame(HEADER + [line('$88.00', 177, 1900, 230, 66), line('上午 9:00', 850, 1980, 200, 52)])
        self.assertEqual(parse.parse_frame(f, 2026)[0], [])

    def test_desktop_frame_is_ignored(self):
        self.assertEqual(parse.parse_frame(frame([line('$12.00', 177, 400, 200, 60)]), 2026)[0], [])

    def test_english_address_wraps_and_icon_prefix(self):
        lines = [
            parse.Line('？台灣桃園市虛構區測試一路', 1.0, 30, 1000, 700, 72),
            parse.Line('Alpha Village, Taoyuan District, Taoyuan Ci', 1.0, 89, 1090, 960, 60),
            parse.Line('Taiwan 330', 1.0, 89, 1160, 254, 41),
        ]
        blocks = parse.group_address_blocks(lines, W)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(parse.join_block(blocks[0], W), '台灣桃園市虛構區測試一路')
        self.assertEqual(parse.join_block(blocks[1], W), 'Alpha Village, Taoyuan District, Taoyuan City, Taiwan 330')

    def test_clipped_postal_code_is_restored(self):
        self.assertEqual(parse.repair_postal('測試路12巷, 中壢區, 桃園市, 台灣 32('), '測試路12巷, 中壢區, 桃園市, 台灣 320')
        self.assertEqual(parse.repair_postal('測試路12巷, 未知區, 桃園市, 台灣 3'), '測試路12巷, 未知區, 桃園市, 台灣')

    def test_precision_levels(self):
        cases = {
            '台灣桃園市虛構區測試路5號': 'address',
            '台灣桃園市虛構區測試路12巷': 'lane',
            'Terminal 1, Taoyuan International Airport (TPE)': 'poi',
            '台灣桃園市虛構區甲乙里測試路一段': 'street',
            'Alpha Village, Bade District, Taoyuan City, Taiwan 334': 'village',
            '台灣桃園市虛構區': 'district',
        }
        for addr, want in cases.items():
            self.assertEqual(parse.precision_of(addr), want, addr)

    def test_district(self):
        self.assertEqual(parse.district_of('台灣桃園市Zhongli District測試路'), '中壢區')
        self.assertEqual(parse.district_of('測試路12巷, 桃園區, 桃園市, 台灣 330'), '桃園區')
        self.assertEqual(parse.district_of('台灣桃園市大園區測試街'), '大園區')

    def test_vote_dedupe_gap_and_validation(self):
        def obs(frame_name, pickup, conf=1.0, start='09:05', fare=150.0, dur=750):
            return parse.Observation(frame_name, (11, 18), start, fare, 0.0, '標準型優步', dur, 4.2, pickup, '乙',
                                     {'head': 1, 'spec': 1, 'pickup': conf, 'dropoff': 1})
        trips = parse.build_trips([
            obs('a', '正確路', 1.0), obs('b', '正確路', 1.0), obs('c', '錯誤路', 0.3),
            obs('d', '下一趟', 1.0, start='09:30', fare=90.0, dur=300),
        ], 2026, 0)
        self.assertEqual(len(trips), 2)
        first, second = trips
        self.assertEqual(first['pickupAddress'], '正確路')
        self.assertEqual(first['dedupeKey'], '2026-11-18|09:05|150|4.20')
        self.assertTrue(first['id'].startswith('vid_') and len(first['id']) == 16)
        self.assertFalse(first['lowSupport'])
        self.assertTrue(second['lowSupport'])
        self.assertEqual(first['raw']['gapBeforeMin'], '')
        self.assertEqual(second['raw']['gapBeforeMin'], '12.5')  # 09:30 − (09:05 + 12:30)
        self.assertIsNone(first['pickupTs'])  # 卡片時間是接單時間，上下客時間要等官方資料
        self.assertEqual(second['requestTs'] - first['requestTs'], 25 * 60_000)
        self.assertTrue(any('1 張畫面' in w for w in parse.validate(trips)))

    def test_overlay_detected_and_ignored(self):
        # 右欄固定不動的浮窗（電流監測）在 30 張畫面都出現；卡片時間剛好在浮窗旁邊時不採用
        overlay = [line('33.5', 1005, 747, 60, 27), line('68%', 1008, 840, 57, 24)]
        frames = [frame(HEADER + overlay + card(300 + i * 5), f'f_{i:04d}.png') for i in range(30)]
        box = parse.find_overlay(frames)
        self.assertEqual(box, (747, 864))
        bad_card = card(650, time_text='上午 9:0②')  # 時間在 y=730，緊貼浮窗
        bad_card[1]['bbox'][0] = 947  # 實機畫面上時間在右欄
        bad = frame(HEADER + overlay + bad_card)
        self.assertEqual(parse.parse_frame(bad, 2026, box)[0], [])
        ok = frame(HEADER + overlay + card(1100))
        self.assertEqual(parse.parse_frame(ok, 2026, box)[0][0].start, '09:05')
        # 結尾停住的卡片不算浮窗（時間樣子的字排除、而且畫面太少）
        self.assertIsNone(parse.find_overlay([frame(HEADER + card(300))] * 8))

    def test_overlay_letter_stripped_from_product(self):
        f = frame(HEADER + card(300, spec='A 標準型優步 · 12分鐘30秒 · 4.20 公里'))
        self.assertEqual(parse.parse_frame(f, 2026)[0][0].product, '標準型優步')

    def test_misread_time_merges_into_same_trip(self):
        # 時間被浮窗蓋到讀錯（11:11 → 11:23），車資、時長、公里都一樣 → 同一趟，時間多數決
        def obs(start, fare=140.0, dur=839, km=3.5, date=(11, 17)):
            return parse.Observation('f', date, start, fare, 0.0, 'Electric', dur, km, '甲路', '乙路',
                                     {'head': 1, 'spec': 1, 'pickup': 1, 'dropoff': 1})
        trips = parse.build_trips([
            obs('11:11'), obs('11:11'), obs('11:23'),
            obs('12:30'),               # 同規格但差超過 30 分鐘：另一趟
            obs('11:15', date=(11, 18)),  # 不同天：另一趟
            obs('11:11', fare=99.0, dur=300, km=1.0),  # 同時間不同卡片內容：仍視為同一趟（沿用舊規則）
        ], 2026, 0)
        starts = sorted((t['dedupeKey'][:10], t['raw']['startLocal']) for t in trips)
        self.assertEqual(starts, [('2026-11-17', '11:11'), ('2026-11-17', '12:30'), ('2026-11-18', '11:15')])


if __name__ == '__main__':
    unittest.main()
