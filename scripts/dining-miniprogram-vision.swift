import Foundation
import ImageIO
import Vision

struct Line: Encodable {
    let text: String
    let x: Double
    let y: Double
}

let png = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
let lines = (request.results ?? []).compactMap { observation -> Line? in
    guard let recognized = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return Line(text: recognized.string, x: box.midX, y: 1 - box.midY)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(lines))
