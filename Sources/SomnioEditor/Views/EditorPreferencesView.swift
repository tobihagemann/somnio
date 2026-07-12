import SomnioCore
import SwiftUI

/// Preferences pane delivered through the editor's `Settings` scene. Surfaces the
/// only editor preference today: the grid-snap preset the drag interaction layer
/// reads on every placement/move/resize to quantize the canvas coordinates.
@MainActor struct EditorPreferencesView: View {
    @State private var gridSnap: GridSnap = EditorDefaults.currentGridSnap()

    var body: some View {
        Form {
            Section(header: Text(L.resource("Grid snap"))) {
                Picker(selection: $gridSnap) {
                    Text(L.resource("Tiled (32x32)")).tag(GridSnap.px32)
                    Text(L.resource("Tiled (16x16)")).tag(GridSnap.px16)
                    Text(L.resource("Tiled (8x8)")).tag(GridSnap.px8)
                    Text(L.resource("Tiled (4x4)")).tag(GridSnap.px4)
                    Text(L.resource("Free")).tag(GridSnap.free)
                } label: {
                    Text(L.resource("Grid snap"))
                }
                .onChange(of: gridSnap) { _, newValue in
                    let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
                    defaults.set(Int(newValue.rawValue), forKey: EditorDefaults.userDefaultsKey)
                }
            }
        }
        .padding(20)
        .frame(width: 360, height: 160)
    }
}
