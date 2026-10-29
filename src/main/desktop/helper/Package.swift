// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "navo-desktop", platforms: [.macOS(.v14)], products: [.executable(name: "navo-desktop", targets: ["NavoDesktop"])], targets: [.executableTarget(name: "NavoDesktop")])
