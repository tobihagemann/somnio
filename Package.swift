// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Somnio",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "SomnioApp", targets: ["SomnioApp"]),
        .executable(name: "SomnioEditor", targets: ["SomnioEditor"]),
        .executable(name: "SomnioServer", targets: ["SomnioServer"]),
        .executable(name: "SomnioCLI", targets: ["SomnioCLI"]),
        .library(name: "SomnioProtocol", targets: ["SomnioProtocol"]),
        .library(name: "SomnioCore", targets: ["SomnioCore"]),
        .library(name: "SomnioData", targets: ["SomnioData"]),
        .library(name: "SomnioUI", targets: ["SomnioUI"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
        .package(url: "https://github.com/apple/swift-log", from: "1.6.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle", from: "2.0.0")
    ],
    targets: [
        .target(name: "SomnioProtocol"),
        .testTarget(name: "SomnioProtocolTests", dependencies: ["SomnioProtocol"]),

        .target(
            name: "SomnioCore",
            dependencies: [
                "SomnioProtocol",
                .product(name: "Logging", package: "swift-log")
            ],
            resources: [.process("Resources/Localizable.xcstrings")]
        ),
        .testTarget(
            name: "SomnioCoreTests",
            dependencies: ["SomnioCore"],
            resources: [.copy("Resources/MapFixtures")]
        ),

        .target(name: "SomnioData", dependencies: ["SomnioCore"]),
        .testTarget(name: "SomnioDataTests", dependencies: ["SomnioData"]),

        .target(name: "SomnioUI", dependencies: [
            "SomnioCore",
            .product(name: "Logging", package: "swift-log")
        ]),
        .testTarget(name: "SomnioUITests", dependencies: ["SomnioUI"]),

        .executableTarget(
            name: "SomnioApp",
            dependencies: [
                "SomnioCore",
                "SomnioUI",
                "SomnioProtocol",
                .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS])),
                .product(name: "Logging", package: "swift-log")
            ],
            resources: [.process("Resources/Localizable.xcstrings")]
        ),

        .executableTarget(
            name: "SomnioEditor",
            dependencies: [
                "SomnioCore",
                "SomnioUI",
                .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS])),
                .product(name: "Logging", package: "swift-log")
            ],
            resources: [.process("Resources/Localizable.xcstrings")]
        ),

        .executableTarget(
            name: "SomnioServer",
            dependencies: [
                "SomnioCore",
                "SomnioData",
                "SomnioProtocol",
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
                .product(name: "Logging", package: "swift-log")
            ]
        ),

        .executableTarget(
            name: "SomnioCLI",
            dependencies: [
                "SomnioCore",
                "SomnioProtocol",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "Logging", package: "swift-log")
            ]
        )
    ]
)
