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
        // Opens the bones window and nothing else, so the window can be
        // launched and screenshotted by a machine. The `openrappter://bones`
        // deep link is the ergonomic path; this is the testable one, and it
        // does not depend on LaunchServices resolving the URL scheme to the
        // right bundle — which on a dev machine with several stale copies
        // installed, it does not.
        .executableTarget(
            name: "ShowBones",
            dependencies: ["OpenRappterBarLib"],
            path: "Sources/ShowBones",
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
