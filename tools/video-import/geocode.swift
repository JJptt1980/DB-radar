// 地址轉經緯度（SPEC 8.3 步驟 6）：Apple CLGeocoder，免費、直接在 Mac 上跑。
// 用法：從 stdin 讀 JSON 字串陣列（已正規化的地址），stdout 輸出 {地址: [lat, lon] 或 null}。
// Apple 有查詢頻率限制，所以一筆一筆查，中間稍微停一下。
import Foundation
import CoreLocation

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let queries = try? JSONDecoder().decode([String].self, from: input) else {
    FileHandle.standardError.write("stdin 要是 JSON 字串陣列\n".data(using: .utf8)!)
    exit(2)
}

var results: [String: Any] = [:]
let geocoder = CLGeocoder()
let taiwan = CLCircularRegion(center: CLLocationCoordinate2D(latitude: 23.7, longitude: 121.0), radius: 250_000, identifier: "tw")

func lookup(_ i: Int) {
    if i >= queries.count {
        let data = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        exit(0)
    }
    let q = queries[i]
    geocoder.geocodeAddressString(q, in: taiwan, preferredLocale: Locale(identifier: "zh_Hant_TW")) { marks, error in
        if let loc = marks?.first?.location {
            results[q] = [loc.coordinate.latitude, loc.coordinate.longitude]
        } else {
            results[q] = NSNull()
            if let error { FileHandle.standardError.write("查不到：\(q)（\(error.localizedDescription)）\n".data(using: .utf8)!) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { lookup(i + 1) }
    }
}

lookup(0)
RunLoop.main.run()
