// Apple Vision OCR（SPEC 8.3 步驟 2）
// 用法：ocr <fps> <frame.png>...
// 每張畫面輸出一行 JSON：{frame, tSec, width, height, lines:[{text, conf, bbox:[x,y,w,h]}]}
// bbox 已換成左上原點的像素座標。tSec 由檔名序號與 fps 推算（ffmpeg 輸出 f_0001.png 起算）。
import Foundation
import Vision
import AppKit

struct Line: Codable {
    let text: String
    let conf: Float
    let bbox: [Int]
}

struct Frame: Codable {
    let frame: String
    let tSec: Double
    let width: Int
    let height: Int
    let lines: [Line]
}

let args = CommandLine.arguments
guard args.count >= 3, let fps = Double(args[1]) else {
    FileHandle.standardError.write("用法：ocr <fps> <frame.png>...\n".data(using: .utf8)!)
    exit(2)
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

for path in args[2...] {
    let url = URL(fileURLWithPath: path)
    guard let image = NSImage(contentsOf: url),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("讀不到圖片：\(path)\n".data(using: .utf8)!)
        continue
    }
    let w = cg.width, h = cg.height
    // 放大 2 倍再辨識：行尾的小字（例如 International 的 l）比較不會漏掉
    let scale = 2
    guard let ctx = CGContext(data: nil, width: w * scale, height: h * scale, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w * scale, height: h * scale))
    guard let big = ctx.makeImage() else { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: big, options: [:])
    do {
        try handler.perform([request])
    } catch {
        FileHandle.standardError.write("OCR 失敗：\(path) \(error)\n".data(using: .utf8)!)
        continue
    }
    var lines: [Line] = []
    for obs in request.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        let x = Int((b.minX * CGFloat(w)).rounded())
        let y = Int(((1 - b.maxY) * CGFloat(h)).rounded())
        let bw = Int((b.width * CGFloat(w)).rounded())
        let bh = Int((b.height * CGFloat(h)).rounded())
        lines.append(Line(text: top.string, conf: top.confidence, bbox: [x, y, bw, bh]))
    }
    lines.sort { ($0.bbox[1], $0.bbox[0]) < ($1.bbox[1], $1.bbox[0]) }
    let name = url.lastPathComponent
    let digits = name.filter(\.isNumber)
    let idx = Double(Int(digits) ?? 1)
    let frame = Frame(frame: name, tSec: (idx - 1) / fps, width: w, height: h, lines: lines)
    if let data = try? encoder.encode(frame), let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}
