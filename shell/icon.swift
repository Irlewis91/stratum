// Places the supplied STRATUM icon artwork on the macOS icon grid (824 px artwork centred in a 1024 px canvas).
// Usage: swift icon.swift assets/stratum-icon.png out.png
import Cocoa

let size = 1024, art = 824
let source = NSImage(contentsOfFile: CommandLine.arguments[1])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .high
let inset = CGFloat(size - art) / 2
source.draw(in: NSRect(x: inset, y: inset, width: CGFloat(art), height: CGFloat(art)), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.current!.flushGraphics()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
