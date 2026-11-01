// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OrderKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "OrderKit", targets: ["OrderKit"])],
    targets: [
        .target(name: "OrderKit"),
        .testTarget(name: "OrderKitTests", dependencies: ["OrderKit"]),
    ]
)
