import AppKit
import SomnioCore
import SwiftUI

/// New-map dialog. Auto-presents on the first appearance of a fresh `SectorDocument`
/// (`isUninitialized == true`), and is re-presentable via the File menu later. On OK
/// the dialog routes both `renameSector` and a full `body` replacement through the
/// single mutation API so a single undo step reverts the New-map commit.
@MainActor struct NewMapDialogView: View {
    let document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var form = workspace.newMapForm
        return Form {
            HStack {
                Text(L.resource("Sector name"))
                TextField("", text: $form.sectorName)
                    .textFieldStyle(.roundedBorder)
            }
            Stepper(value: $form.width, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Width"), value: form.width)
            }
            Stepper(value: $form.height, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Height"), value: form.height)
            }
            Picker(selection: $form.indoor) {
                Text(L.resource("Yes")).tag(true)
                Text(L.resource("No")).tag(false)
            } label: {
                Text(L.resource("Indoor"))
            }
            Stepper(value: $form.brightness, in: 0 ... 100) {
                StepperLabel(title: L.resource("Light"), value: form.brightness)
            }
            RegistryIDPicker(title: L.resource("Floor material"), ids: EditorDefaults.floorMaterialIDs, selection: $form.floorMaterialID)
            if let message = validationMessage(form: form) {
                Text(message)
                    .foregroundStyle(.red)
            }
            HStack {
                Button(role: .cancel) {
                    if document.isUninitialized {
                        NSApp.keyWindow?.performClose(nil)
                    } else {
                        dismiss()
                    }
                } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    commit(form: form)
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(validationMessage(form: form) != nil)
            }
        }
        .padding(20)
        .frame(width: 360)
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
        dismiss()
    }

    private func validationMessage(form: NewMapFormState) -> LocalizedStringResource? {
        if form.sectorName.isEmpty { return L.resource("Fill in sector name!") }
        if form.brightness < 0 || form.brightness > 100 { return L.resource("Fill in light!") }
        return nil
    }
}
