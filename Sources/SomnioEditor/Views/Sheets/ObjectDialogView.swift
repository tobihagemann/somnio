import SomnioCore
import SwiftUI

/// Object placement dialog. Bound to `workspace.objectForm`; the OK handler appends an
/// `Object` to the document's `SectorBody` through the single `mutate` API and dismisses
/// itself.
@MainActor struct ObjectDialogView: View {
    let document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var form = workspace.objectForm
        return Form {
            Stepper(value: $form.x, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("X"), value: form.x)
            }
            Stepper(value: $form.y, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("Y"), value: form.y)
            }
            RegistryIDPicker(title: L.resource("Model"), ids: EditorDefaults.objectModelIDs, selection: $form.modelID)
            Stepper(value: $form.sourceWidth, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Width"), value: form.sourceWidth)
            }
            Stepper(value: $form.sourceHeight, in: 1 ... Int16.max) {
                StepperLabel(title: L.resource("Height"), value: form.sourceHeight)
            }
            Stepper(value: $form.priority, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("Priority"), value: form.priority)
            }
            HStack {
                Button(role: .cancel) { dismiss() } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    let object = form.buildObject()
                    document.mutate("Place object", undoManager: undoManager) { body in
                        body.objects.append(object)
                    }
                    dismiss()
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}
