import SomnioProtocol
import SwiftUI

/// Login sheet — control inventory matches the legacy `LoginFenster`. Pre-validates
/// nickname and password length against the same caps the server enforces, so an
/// oversized field is rejected in-form before the round-trip. The cap constants live
/// in `SomnioProtocolConstants` so server handlers and client sheets read from one
/// source of truth.
@MainActor struct LoginSheetView: View {
    let viewModel: ClientViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var form = viewModel.loginForm
        return VStack(alignment: .leading, spacing: 12) {
            Text(L.resource("Nickname"))
            TextField("", text: $form.nickname)
                .textFieldStyle(.roundedBorder)
            Text(L.resource("Password"))
            SecureField("", text: $form.password)
                .textFieldStyle(.roundedBorder)
            Toggle(isOn: $form.rememberPassword) {
                Text(L.resource("Remember password"))
            }
            Button {
                viewModel.presentedSheet = .registration
            } label: {
                Text(L.resource("If you don't have an account, click here!"))
            }
            .buttonStyle(.link)

            HStack {
                Button(role: .cancel) {
                    dismiss()
                } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    viewModel.submitLogin()
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid(form: form))
            }
        }
        .padding(20)
        .frame(width: 320)
    }

    private func isValid(form: LoginFormState) -> Bool {
        guard !form.nickname.isEmpty, !form.password.isEmpty else { return false }
        guard form.nickname.utf8.count <= SomnioProtocolConstants.maxIdentifierUTF8Bytes else { return false }
        guard form.password.utf8.count <= SomnioProtocolConstants.maxPasswordUTF8Bytes else { return false }
        return true
    }
}
