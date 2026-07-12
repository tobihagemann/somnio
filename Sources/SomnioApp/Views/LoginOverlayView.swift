import SomnioProtocol
import SomnioTheme
import SwiftUI

/// Login overlay — control inventory matches the legacy `LoginFenster`, restyled onto a
/// `FantasyPanel` over the world. No close control: the login overlay auto-presents
/// whenever the player is not attached, so there is nothing behind it to return to.
/// Pre-validates nickname and password length against the same caps the server enforces,
/// so an oversized field is rejected in-form before the round-trip. The cap constants
/// live in `SomnioProtocolConstants` so server handlers and client overlays read from one
/// source of truth.
@MainActor struct LoginOverlayView: View {
    let viewModel: ClientViewModel

    var body: some View {
        @Bindable var form = viewModel.loginForm
        return FantasyPanel(title: L.resource("Somnio")) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.resource("Nickname"))
                TextField("", text: $form.nickname)
                    .fantasyFieldChrome()
                Text(L.resource("Password"))
                SecureField("", text: $form.password)
                    .fantasyFieldChrome()
                Toggle(isOn: $form.rememberPassword) {
                    Text(L.resource("Remember password"))
                }
                Button {
                    viewModel.presentedOverlay = .registration
                } label: {
                    Text(L.resource("If you don't have an account, click here!"))
                }
                .buttonStyle(.link)

                HStack {
                    Spacer()
                    Button {
                        viewModel.submitLogin()
                    } label: {
                        Text(L.resource("OK"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid(form: form))
                }
            }
        }
        .frame(width: 340)
    }

    private func isValid(form: LoginFormState) -> Bool {
        guard !form.nickname.isEmpty, !form.password.isEmpty else { return false }
        guard form.nickname.utf8.count <= SomnioProtocolConstants.maxIdentifierUTF8Bytes else { return false }
        guard form.password.utf8.count <= SomnioProtocolConstants.maxPasswordUTF8Bytes else { return false }
        return true
    }
}
