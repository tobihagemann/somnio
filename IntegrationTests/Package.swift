// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SomnioIntegrationTests",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(name: "Somnio", path: ".."),
        .package(url: "https://github.com/vapor/postgres-nio", from: "1.21.0"),
        .package(url: "https://github.com/apple/swift-log", from: "1.6.0")
    ],
    targets: [
        .testTarget(
            name: "SomnioIntegrationTests",
            dependencies: [
                .product(name: "SomnioCore", package: "Somnio"),
                .product(name: "SomnioData", package: "Somnio"),
                .product(name: "SomnioProtocol", package: "Somnio"),
                .product(name: "PostgresNIO", package: "postgres-nio"),
                .product(name: "Logging", package: "swift-log")
            ]
        )
    ]
)
