// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SomnioIntegrationTests",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(name: "Somnio", path: "..")
    ],
    targets: [
        .testTarget(
            name: "SomnioIntegrationTests",
            dependencies: [
                .product(name: "SomnioCore", package: "Somnio"),
                .product(name: "SomnioData", package: "Somnio"),
                .product(name: "SomnioProtocol", package: "Somnio")
            ]
        )
    ]
)
