import RealityKit
import Testing
@testable import SomnioScene3D

/// Pins the traversal contract of the shared clip-enumeration seam. This is pure entity-graph
/// data work (programmatic entities + `AnimationLibraryComponent`), not a RealityKit file load,
/// so it runs headlessly like the other entity-graph suites.
@MainActor
struct RealityKitAnimationClipsTests {
    /// A named animation generated purely from data — `availableAnimations` reports the
    /// resource's own name, not the library dictionary key.
    private func namedClip(_ name: String) throws -> AnimationResource {
        try AnimationResource.generate(with: FromToByAnimation<Transform>(
            name: name,
            from: .identity,
            to: Transform(translation: [1, 0, 0]),
            duration: 0.1,
            bindTarget: .transform
        ))
    }

    @Test func `names collects clips from the root and descendants in depth-first order`() throws {
        let root = Entity()
        let childA = Entity()
        let childB = Entity()
        let grandchild = Entity()
        root.addChild(childA)
        root.addChild(childB)
        childA.addChild(grandchild)
        try root.components.set(AnimationLibraryComponent(animations: ["a": namedClip("RootClip")]))
        try grandchild.components.set(AnimationLibraryComponent(animations: ["b": namedClip("GrandchildClip")]))
        try childB.components.set(AnimationLibraryComponent(animations: ["c": namedClip("ChildBClip")]))

        #expect(RealityKitAnimationClips.names(in: root) == ["RootClip", "GrandchildClip", "ChildBClip"])
    }

    @Test func `names is empty for a hierarchy with no animations`() {
        let root = Entity()
        root.addChild(Entity())
        #expect(RealityKitAnimationClips.names(in: root).isEmpty)
    }
}
