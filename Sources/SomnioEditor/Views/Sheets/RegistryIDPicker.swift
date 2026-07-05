import SwiftUI

/// Registry-sourced id picker shared by the editor dialogs (the Object dialog's model ids,
/// the New-map dialog's floor-material ids), keeping the verbatim-id `Text`/`tag` idiom in
/// one place. Mirrors `StepperLabel`'s role as a shared sheet-form helper.
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
