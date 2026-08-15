import Foundation
import Vision

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: ocr_vision <image_path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let imageData = try? Data(contentsOf: imageURL),
      let cgImageSource = CGImageSourceCreateWithData(imageData as CFData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(cgImageSource, 0, nil)
else {
    fputs("Error: cannot load image at \(imagePath)\n", stderr)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var recognizedText = ""

let request = VNRecognizeTextRequest { request, error in
    defer { semaphore.signal() }
    if let error = error {
        fputs("OCR error: \(error.localizedDescription)\n", stderr)
        return
    }
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    recognizedText = observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US", "pl-PL"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("Vision handler error: \(error.localizedDescription)\n", stderr)
    exit(1)
}

semaphore.wait()
print(recognizedText)
