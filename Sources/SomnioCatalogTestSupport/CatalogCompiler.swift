import Foundation

/// Thrown (rather than asserted) for the same reason as `CatalogValidationError`: an
/// uncaught throw fails the calling `@Test`, and `description` names the failure.
public enum CatalogCompilerError: Error, CustomStringConvertible, Sendable, Equatable {
    case toolUnavailable
    case compileFailed(status: Int32)

    public var description: String {
        switch self {
        case .toolUnavailable:
            "xcstringstool not found (Xcode toolchain required)"
        case let .compileFailed(status):
            "xcstringstool compile exited with status \(status)"
        }
    }
}

/// Compiles a `.xcstrings` catalog into per-locale `<lang>.lproj/Localizable.strings`
/// artifacts via the Xcode toolchain's `xcstringstool` — the build step SwiftPM's native
/// build never runs (see `CatalogParser`). Lets tests exercise Foundation's runtime
/// resolution against the compiled form that `Scripts/package_app.sh` ships in the
/// packaged apps.
public enum CatalogCompiler {
    #if canImport(Darwin)
        /// Absolute `xcstringstool` location, resolved once via `xcrun --find`; `nil` when
        /// the Xcode toolchain is absent (e.g. Command Line Tools-only hosts).
        private static let toolURL: URL? = {
            let xcrun = Process()
            xcrun.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            xcrun.arguments = ["--find", "xcstringstool"]
            let stdout = Pipe()
            xcrun.standardOutput = stdout
            xcrun.standardError = FileHandle.nullDevice
            do {
                try xcrun.run()
            } catch {
                return nil
            }
            let output = stdout.fileHandleForReading.readDataToEndOfFile()
            xcrun.waitUntilExit()
            guard xcrun.terminationStatus == 0 else { return nil }
            let path = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return nil }
            return URL(fileURLWithPath: path)
        }()

        public static var isAvailable: Bool {
            toolURL != nil
        }

        /// Compiles the catalog at `sourceURL` into a fresh temporary `.bundle` directory
        /// and returns its URL. The emitted `<lang>.lproj` subdirectories can be loaded as
        /// their own `Bundle`s to pin a locale's table deterministically — the process's
        /// preferred-language resolution would otherwise select English regardless of any
        /// `locale:` argument.
        public static func compileToTemporaryBundle(catalogAt sourceURL: URL) throws -> URL {
            guard let toolURL else { throw CatalogCompilerError.toolUnavailable }
            let bundleURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString).bundle", isDirectory: true)
            try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
            do {
                let compile = Process()
                compile.executableURL = toolURL
                compile.arguments = ["compile", sourceURL.path, "-o", bundleURL.path]
                compile.standardOutput = FileHandle.nullDevice
                compile.standardError = FileHandle.nullDevice
                try compile.run()
                compile.waitUntilExit()
                guard compile.terminationStatus == 0 else {
                    throw CatalogCompilerError.compileFailed(status: compile.terminationStatus)
                }
            } catch {
                try? FileManager.default.removeItem(at: bundleURL)
                throw error
            }
            return bundleURL
        }
    #else
        public static var isAvailable: Bool {
            false
        }
    #endif
}
