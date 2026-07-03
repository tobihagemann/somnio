#if canImport(RealityKit)
    import Foundation
    import RealityKit
    import SomnioCore
    import SomnioScene3D

    /// Build-machine gate for the glb→USDZ conversion: loads a converted model the way the player
    /// will (`Entity(contentsOf:)`) and asserts the expected named animation clips actually surface
    /// through RealityKit — a USD-prim-level check alone cannot prove that. Run by the asset
    /// repo's `Pipeline/convert-glb-to-usdz.sh` after each conversion; exits 1 naming the missing
    /// clips when the conversion collapsed the clip library, 2 on usage or load errors.
    ///
    /// Usage: SomnioAssetValidator <model.usdz> [expected-clip ...]
    /// Without explicit clip arguments the expected clips come from the committed model registry,
    /// resolved by the file's stem.
    @main
    @MainActor
    enum SomnioAssetValidatorEntry {
        static func main() async {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let path = arguments.first else {
                fail("usage: SomnioAssetValidator <model.usdz> [expected-clip ...]", exitCode: 2)
            }
            let url = URL(filePath: path)
            let stem = url.deletingPathExtension().lastPathComponent

            let expected: [String]
            if arguments.count > 1 {
                expected = Array(arguments.dropFirst())
            } else {
                let registry = loadRegistry()
                guard let clips = registry.expectedClips(forStem: stem) else {
                    // Static props have no registry clip contract; still prove the file loads.
                    print("\(stem): no model registry entry; asserting loadability only.")
                    _ = await load(url)
                    return
                }
                expected = clips
            }

            let entity = await load(url)
            let actual = RealityKitAnimationClips.names(in: entity)
            let missing = ModelRegistry.missingClips(expected: expected, actual: actual)
            guard missing.isEmpty else {
                fail("""
                \(stem): missing expected animation clips: \(missing.sorted().joined(separator: ", "))
                RealityKit surfaces only: \(actual.sorted().joined(separator: ", "))
                The glb→USDZ conversion likely collapsed the named-clip library into a single timeline.
                """, exitCode: 1)
            }
            print("\(stem): all \(expected.count) expected clips present (\(actual.count) total).")
        }

        private static func load(_ url: URL) async -> Entity {
            do {
                return try await Entity(contentsOf: url)
            } catch {
                fail("failed to load \(url.path): \(error)", exitCode: 2)
            }
        }

        private static func loadRegistry() -> ModelRegistry {
            do {
                return try ModelRegistryCodec.bundledRegistry()
            } catch {
                fail("failed to load the committed model registry: \(error)", exitCode: 2)
            }
        }

        private static func fail(_ message: String, exitCode: Int32) -> Never {
            FileHandle.standardError.write(Data("\(message)\n".utf8))
            exit(exitCode)
        }
    }
#else
    import Foundation

    /// The validator exercises RealityKit's loader, so it is meaningful only on Apple platforms; a
    /// non-Apple build compiles this stub instead of failing the whole-package build.
    @main
    enum SomnioAssetValidatorEntry {
        static func main() {
            FileHandle.standardError.write(Data("SomnioAssetValidator requires RealityKit (Apple platforms only).\n".utf8))
            exit(2)
        }
    }
#endif
