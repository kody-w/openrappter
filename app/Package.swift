// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenRappter",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned by commit, never by branch (Docker `latest` lesson). Fork of MrKai77/DynamicNotchKit.
        .package(url: "https://github.com/menufactory43/DynamicNotchKit", revision: "cd0b3e52d537db115ad3a9d89601f20e0bee8d27"),
    ],
    targets: [
        // Everything testable: creature model, senses parser, mind client, kernel runner.
        .target(
            name: "OpenRappterCore",
            path: "Sources/OpenRappterCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The notch app itself.
        .executableTarget(
            name: "OpenRappter",
            dependencies: ["OpenRappterCore", .product(name: "DynamicNotchKit", package: "DynamicNotchKit")],
            path: "Sources/OpenRappter",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OpenRappterCoreTests",
            dependencies: ["OpenRappterCore"],
            path: "Tests/OpenRappterCoreTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
