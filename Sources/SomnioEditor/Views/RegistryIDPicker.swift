import SwiftUI

/// Registry-sourced id picker shared by the inspector (object model ids) and the sector
/// overlays (floor-material ids), keeping the verbatim-id `Text`/`tag` idiom in one place.
/// Mirrors `StepperLabel`'s role as a shared form helper.
@MainActor struct RegistryIDPicker: View {
    let title: LocalizedStringResource
    let ids: [String]
    @Binding var selection: String

    var body: some View {
        Picker(selection: $selection) {
            ForEach(ids, id: \.self) { id in
                Text(verbatim: id).tag(id)
            }
        } label: {
            Text(title)
        }
    }
}
