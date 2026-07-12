import SomnioCore
import SomnioTheme
import SwiftUI

/// Sector-level settings overlay for an initialized document: name, dimensions, floor
/// material, and light. Edits are local drafts committed as one Apply — dimensions commit
/// only as a valid width×height pair (the `MapCodec` bounds), never one axis at a time
/// through a temporarily invalid sector.
@MainActor struct SectorSettingsOverlayView: View {
    @ObservedObject var document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.undoManager) private var undoManager

    @State private var sectorName: String
    @State private var width: Int16
    @State private var height: Int16
    @State private var indoor: Bool
    @State private var brightness: Int16
    @State private var floorMaterialID: String

    init(document: SectorDocument, workspace: SectorWorkspace) {
        self.document = document
        self.workspace = workspace
        self._sectorName = State(initialValue: document.sectorName)
        self._width = State(initialValue: document.body.dimensions.width)
        self._height = State(initialValue: document.body.dimensions.height)
        self._indoor = State(initialValue: document.body.light.indoor)
        self._brightness = State(initialValue: document.body.light.brightness)
        self._floorMaterialID = State(initialValue: document.body.floorMaterialID)
    }

    var body: some View {
        FantasyPanel(title: L.resource("Sector Settings")) {
            VStack(alignment: .leading, spacing: 10) {
                SectorFieldsForm(
                    sectorName: $sectorName,
                    width: $width,
                    height: $height,
                    indoor: $indoor,
                    brightness: $brightness,
                    floorMaterialID: $floorMaterialID,
                    validationMessage: validationMessage
                )
                HStack {
                    Button(role: .cancel) {
                        // Same back path as Esc: return to the game menu, not the canvas.
                        workspace.presentedOverlay = .gameMenu
                    } label: {
                        Text(L.resource("Cancel"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    Spacer()
                    Button {
                        commit()
                    } label: {
                        Text(L.resource("Apply"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(validationMessage != nil)
                }
            }
        }
        .frame(width: 380)
    }

    private var validationMessage: LocalizedStringResource? {
        SectorFieldsForm.validationMessage(sectorName: sectorName, width: width, height: height)
    }

    private func commit() {
        if sectorName != document.sectorName {
            document.renameSector(to: sectorName, undoManager: undoManager)
        }
        let dimensions = GridSize(width: width, height: height)
        let light = LightSetting(indoor: indoor, brightness: brightness)
        let floorMaterialID = floorMaterialID
        if dimensions != document.body.dimensions || light != document.body.light || floorMaterialID != document.body.floorMaterialID {
            document.mutate("Edit sector settings", undoManager: undoManager) { body in
                body.dimensions = dimensions
                body.floorMaterialID = floorMaterialID
                body.light = light
            }
        }
        workspace.presentedOverlay = nil
    }
}
