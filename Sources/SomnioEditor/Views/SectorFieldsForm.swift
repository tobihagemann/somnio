import SomnioCore
import SomnioTheme
import SwiftUI

/// The sector-attribute form shared by the new-map and sector-settings overlays: name,
/// tile dimensions (bounded to the `MapCodec` per-axis cap), light, and floor material,
/// plus the inline validation line. The overlays differ only in backing store and commit
/// semantics, so the field layout lives here once.
@MainActor struct SectorFieldsForm: View {
    @Binding var sectorName: String
    @Binding var width: Int16
    @Binding var height: Int16
    @Binding var indoor: Bool
    @Binding var brightness: Int16
    @Binding var floorMaterialID: String
    let validationMessage: LocalizedStringResource?

    var body: some View {
        HStack {
            Text(L.resource("Sector name"))
            TextField("", text: $sectorName)
                .fantasyFieldChrome()
        }
        Stepper(value: $width, in: 1 ... SomnioConstants.maxSectorDimension) {
            StepperLabel(title: L.resource("Width"), value: width)
        }
        Stepper(value: $height, in: 1 ... SomnioConstants.maxSectorDimension) {
            StepperLabel(title: L.resource("Height"), value: height)
        }
        Picker(selection: $indoor) {
            Text(L.resource("Yes")).tag(true)
            Text(L.resource("No")).tag(false)
        } label: {
            Text(L.resource("Indoor"))
        }
        Stepper(value: $brightness, in: 0 ... 100) {
            StepperLabel(title: L.resource("Light"), value: brightness)
        }
        RegistryIDPicker(title: L.resource("Floor material"), ids: EditorDefaults.floorMaterialIDs, selection: $floorMaterialID)
        if let validationMessage {
            Text(validationMessage)
                .foregroundStyle(FantasyPalette.errorRed)
        }
    }

    /// The shared validation: a sector needs a name and a width×height pair the codec
    /// will round-trip (the steppers already bound each axis, so the area product is the
    /// reachable failure).
    static func validationMessage(sectorName: String, width: Int16, height: Int16) -> LocalizedStringResource? {
        if sectorName.isEmpty { return L.resource("Fill in sector name!") }
        if !EditorDefaults.validSectorDimensions(width: width, height: height) {
            return L.resource("Invalid sector size!")
        }
        return nil
    }
}
