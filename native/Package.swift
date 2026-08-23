// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DSHComputerHelper",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ComputerCore", targets: ["ComputerCore"]),
        .executable(name: "dsh-computer-helper", targets: ["DSHComputerHelper"]),
    ],
    targets: [
        .target(name: "ComputerCore"),
        .executableTarget(
            name: "DSHComputerHelper",
            dependencies: ["ComputerCore"],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
            ]
        ),
        .testTarget(name: "ComputerCoreTests", dependencies: ["ComputerCore"]),
    ]
)
