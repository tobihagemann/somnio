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
        .library(name: "SomnioUI", targets: ["SomnioUI"]),
        .library(name: "SomnioServerCore", targets: ["SomnioServerCore"]),
        .library(name: "SomnioCLICore", targets: ["SomnioCLICore"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
        .package(url: "https://github.com/apple/swift-log", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-nio", from: "2.0.0"),
        .package(url: "https://github.com/swift-server/swift-service-lifecycle", from: "2.0.0"),
        .package(url: "https://github.com/vapor/postgres-nio", from: "1.21.0"),
        .package(url: "https://github.com/hummingbird-project/hummingbird", from: "2.0.0"),
        .package(url: "https://github.com/hummingbird-project/hummingbird-websocket", from: "2.0.0")
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

        .systemLibrary(
            name: "CArgon2",
            path: "Sources/CArgon2",
            pkgConfig: "libargon2",
            providers: [.brew(["argon2"]), .apt(["libargon2-dev"])]
        ),

        .target(
            name: "SomnioData",
            dependencies: [
                "SomnioCore",
                "CArgon2",
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "Logging", package: "swift-log")
            ]
        ),
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

        .target(
            name: "SomnioServerCore",
            dependencies: [
                "SomnioCore",
                "SomnioData",
                "SomnioProtocol",
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "ServiceLifecycle", package: "swift-service-lifecycle"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "NIOFoundationCompat", package: "swift-nio")
            ]
        ),
        .target(
            name: "SomnioTestSupport",
            dependencies: [
                "SomnioCore",
                "SomnioData",
                "SomnioProtocol",
                "SomnioServerCore",
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
                .product(name: "Logging", package: "swift-log")
            ]
        ),

        .testTarget(
            name: "SomnioServerCoreTests",
            dependencies: [
                "SomnioServerCore",
                "SomnioTestSupport",
                .product(name: "HummingbirdTesting", package: "hummingbird"),
                .product(name: "HummingbirdWSTesting", package: "hummingbird-websocket")
            ],
            resources: [
                .copy("Resources/Corrupt"),
                .copy("Resources/MapFixtures")
            ]
        ),

        .executableTarget(
            name: "SomnioServer",
            dependencies: [
                "SomnioServerCore",
                .product(name: "Logging", package: "swift-log")
            ]
        ),

        .target(
            name: "SomnioCLICore",
            dependencies: [
                "SomnioCore",
                "SomnioProtocol",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "HummingbirdWSClient", package: "hummingbird-websocket"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOFoundationCompat", package: "swift-nio")
            ],
            resources: [.process("Resources/Localizable.xcstrings")]
        ),
        .testTarget(
            name: "SomnioCLICoreTests",
            dependencies: [
                "SomnioCLICore",
                "SomnioServerCore",
                "SomnioTestSupport",
                .product(name: "HummingbirdTesting", package: "hummingbird"),
                .product(name: "HummingbirdWSTesting", package: "hummingbird-websocket")
            ]
        ),

        .executableTarget(
            name: "SomnioCLI",
            dependencies: ["SomnioCLICore"]
        )
    ]
)
