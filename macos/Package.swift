// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenRappterBar",
    platforms: [.macOS(.v14)],
    targets: [
        // Library with all logic
        .target(
            name: "OpenRappterBarLib",
            path: "Sources/OpenRappterBar",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // App entry point
        .executableTarget(
            name: "OpenRappterBar",
            dependencies: ["OpenRappterBarLib"],
            path: "Sources/OpenRappterBarApp",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Test executable
        .executableTarget(
            name: "RunTests",
            dependencies: ["OpenRappterBarLib"],
            path: "Tests/OpenRappterBarTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
