import SomnioCore
import SwiftUI

/// Sector-portal placement dialog. Direction picker uses `PortalDirection.allCases`
/// directly so adding a future direction case automatically surfaces a new option.
@MainActor struct PortalDialogView: View {
    let document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var form = workspace.portalForm
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
                Text(L.resource("Target sector"))
                TextField("", text: $form.targetSectorName)
                    .textFieldStyle(.roundedBorder)
            }
            Picker(selection: $form.direction) {
                ForEach(PortalDirection.allCases, id: \.rawValue) { direction in
                    Text(label(for: direction)).tag(direction)
                }
            } label: {
                Text(L.resource("Direction"))
            }
            if !isValid(form: form) {
                Text(L.resource("Fill in sector name!"))
                    .foregroundStyle(.red)
            }
            HStack {
                Button(role: .cancel) { dismiss() } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    let portal = form.buildPortal()
                    document.mutate("Place sector portal", undoManager: undoManager) { body in
                        body.portals.append(portal)
                    }
                    dismiss()
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid(form: form))
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    private func label(for direction: PortalDirection) -> LocalizedStringResource {
        switch direction {
        case .outboundTrigger: return L.resource("Outbound trigger")
        case .arrivalPlacement: return L.resource("Arrival placement")
        }
    }

    private func isValid(form: PortalFormState) -> Bool {
        !form.targetSectorName.isEmpty && form.width > 0 && form.height > 0
    }
}
