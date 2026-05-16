import SomnioCore
import SwiftUI

/// Collision-mask placement dialog. Same OK/Cancel + inline validation idiom as the
/// other per-tool dialogs.
@MainActor struct MaskDialogView: View {
    let document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var form = workspace.maskForm
        return Form {
            Stepper(value: $form.x, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("X"), value: form.x)
            }
            Stepper(value: $form.y, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("Y"), value: form.y)
            }
            Stepper(value: $form.width, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Width"), value: form.width)
            }
            Stepper(value: $form.height, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Height"), value: form.height)
            }
            HStack {
                Button(role: .cancel) { dismiss() } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    let mask = form.buildMask()
                    document.mutate("Place collision mask", undoManager: undoManager) { body in
                        body.collisionMasks.append(mask)
                    }
                    dismiss()
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 320)
    }
}
