import SomnioCore
import SomnioProtocol
import SomnioUI
import SwiftUI

/// Registration overlay — control inventory matches the legacy `RegistrationFenster`,
/// restyled onto a `FantasyPanel`. On submit the view model dispatches `.register` over a
/// fresh socket and re-presents the login overlay on success; Cancel (and Esc) return to
/// the login overlay. The cap constants live in `SomnioProtocolConstants` so server
/// handlers and client overlays read from one source of truth.
@MainActor struct RegistrationOverlayView: View {
    let viewModel: ClientViewModel

    var body: some View {
        @Bindable var form = viewModel.registrationForm
        return FantasyPanel {
            VStack(alignment: .leading, spacing: 12) {
                labeledField(L.resource("Nickname:")) {
                    TextField("", text: $form.nickname)
                        .fantasyFieldChrome()
                }
                labeledField(L.resource("Password:")) {
                    SecureField("", text: $form.password)
                        .fantasyFieldChrome()
                }
                labeledField(L.resource("Password (*):")) {
                    SecureField("", text: $form.passwordRepeat)
                        .fantasyFieldChrome()
                }
                Text(L.resource("*: repeat"))
                    .font(.caption)
                Picker(selection: $form.characterClass) {
                    ForEach(CharacterClass.allCases, id: \.rawValue) { characterClass in
                        Text(verbatim: characterClass.displayName).tag(characterClass)
                    }
                } label: {
                    Text(L.resource("Character:"))
                }
                Picker(selection: $form.gender) {
                    ForEach(Gender.allCases, id: \.rawValue) { gender in
                        Text(verbatim: gender.displayName).tag(gender)
                    }
                } label: {
                    Text(L.resource("Gender:"))
                }
                labeledField(L.resource("Email:")) {
                    TextField("", text: $form.email)
                        .fantasyFieldChrome()
                }
                if let error = form.lastError {
                    Text(Self.message(for: error))
                        .foregroundStyle(FantasyPalette.errorRed)
                }
                HStack {
                    Button(role: .cancel) {
                        viewModel.cancelRegistration()
                    } label: {
                        Text(L.resource("Cancel"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    Spacer()
                    Button {
                        viewModel.submitRegistration()
                    } label: {
                        Text(L.resource("OK"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid(form: form))
                }
            }
        }
        .frame(width: 400)
    }

    private func labeledField(_ title: LocalizedStringResource, @ViewBuilder field: () -> some View) -> some View {
        HStack {
            Text(title)
                .frame(width: 110, alignment: .leading)
            field()
        }
    }

    private static func message(for error: RegistrationError) -> LocalizedStringResource {
        switch error {
        case .nicknameExists: return L.resource("Nickname already exists.")
        case .nameNotAllowed: return L.resource("That name uses characters Somnio does not allow.")
        case .failure: return L.resource("Registration failed.")
        }
    }

    private func isValid(form: RegistrationFormState) -> Bool {
        let identifierCap = SomnioProtocolConstants.maxIdentifierUTF8Bytes
        let passwordCap = SomnioProtocolConstants.maxPasswordUTF8Bytes
        guard !form.nickname.isEmpty, form.nickname.utf8.count <= identifierCap else { return false }
        // The server enforces the same UTF-8 byte floor; mirroring exactly here means a
        // non-ASCII password whose grapheme count is below the floor but whose UTF-8
        // byte count clears it isn't blocked client-side.
        let passwordFloor = SomnioProtocolConstants.minPasswordUTF8Bytes
        guard form.password.utf8.count >= passwordFloor, form.password.utf8.count <= passwordCap else { return false }
        guard form.password == form.passwordRepeat else { return false }
        guard !form.email.isEmpty, form.email.utf8.count <= identifierCap else { return false }
        return true
    }
}
