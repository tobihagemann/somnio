import AppKit
import SomnioCore
import SomnioTheme
import SwiftUI

/// New-map overlay. Auto-presents on the first appearance of a fresh `SectorDocument`
/// (`isUninitialized == true`) and replaces that document's geometry in place — an
/// initialized document changes its sector-level fields through the Sector Settings
/// overlay instead. On OK it routes both `renameSector` and a full `body` replacement
/// through the single mutation API. Dimensions are validated against the same bounds
/// `MapCodec` enforces — an out-of-range sector could never be reopened.
@MainActor struct NewMapOverlayView: View {
    @ObservedObject var document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var form = workspace.newMapForm
        return FantasyPanel(title: L.resource("Create new map")) {
            VStack(alignment: .leading, spacing: 10) {
                SectorFieldsForm(
                    sectorName: $form.sectorName,
                    width: $form.width,
                    height: $form.height,
                    indoor: $form.indoor,
                    brightness: $form.brightness,
                    floorMaterialID: $form.floorMaterialID,
                    validationMessage: validationMessage(form: form)
                )
                HStack {
                    Button(role: .cancel) {
                        if document.isUninitialized {
                            NSApp.keyWindow?.performClose(nil)
                        } else {
                            // Same back path as Esc: return to the game menu.
                            workspace.presentedOverlay = .gameMenu
                        }
                    } label: {
                        Text(L.resource("Cancel"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    Spacer()
                    Button {
                        commit(form: form)
                    } label: {
                        Text(L.resource("OK"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(validationMessage(form: form) != nil)
                }
            }
        }
        .frame(width: 380)
    }

    private func commit(form: NewMapFormState) {
        let name = form.sectorName
        let width = form.width
        let height = form.height
        let indoor = form.indoor
        let brightness = form.brightness
        let floorMaterialID = form.floorMaterialID
        document.renameSector(to: name, undoManager: undoManager)
        document.mutate("Create new map", undoManager: undoManager) { body in
            body = SectorBody(
                version: EditorDefaults.defaultSectorVersion,
                dimensions: GridSize(width: width, height: height),
                floorMaterialID: floorMaterialID,
                light: LightSetting(indoor: indoor, brightness: brightness),
                objects: [],
                collisionMasks: [],
                portals: [],
                npcs: [],
                monsterSpawns: []
            )
        }
        workspace.didCompleteInitialSetup = true
        workspace.presentedOverlay = nil
    }

    private func validationMessage(form: NewMapFormState) -> LocalizedStringResource? {
        SectorFieldsForm.validationMessage(sectorName: form.sectorName, width: form.width, height: form.height)
    }
}
