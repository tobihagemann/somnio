import RealityKit

/// Somnio's single interpretation of which named animation clips RealityKit surfaces for a
/// loaded model. The runtime loader's clip-collapse warning and the build-machine validator's
/// conversion gate both compare these names against the registry's `expectedClips` (via
/// `ModelRegistry.missingClips`), so the enumeration must never drift between the two — if
/// RealityKit ever exposes clips from a different node shape, this is the one place to adapt.
public enum RealityKitAnimationClips {
    /// All clip names across an entity hierarchy. Clips can hang off a descendant (the skeleton
    /// root) rather than the file's root entity, so the whole tree is walked.
    @MainActor public static func names(in entity: Entity) -> [String] {
        var clipNames = entity.availableAnimations.compactMap(\.name)
        for child in entity.children {
            clipNames.append(contentsOf: names(in: child))
        }
        return clipNames
    }
}
