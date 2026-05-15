import SomnioCore
import SomnioProtocol
import SwiftUI

/// Registration sheet — control inventory matches the legacy `RegistrationFenster`.
/// On submit the view model dispatches `.register` over a fresh socket and re-presents
/// the Login sheet on success. The cap constants live in `SomnioProtocolConstants` so
/// server handlers and client sheets read from one source of truth.
@MainActor struct RegistrationSheetView: View {
    let viewModel: ClientViewModel
    @Environment(\.dismiss) private var dismiss

    private let minPasswordLength = 8

    var body: some View {
        @Bindable var form = viewModel.registrationForm
        return Form {
            HStack {
                Text(L.resource("Nickname:"))
                TextField("", text: $form.nickname)
                    .textFieldStyle(.roundedBorder)
            }
            HStack {
                Text(L.resource("Password:"))
                SecureField("", text: $form.password)
                    .textFieldStyle(.roundedBorder)
            }
            HStack {
                Text(L.resource("Password (*):"))
                SecureField("", text: $form.passwordRepeat)
                    .textFieldStyle(.roundedBorder)
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
            HStack {
                Text(L.resource("Email:"))
                TextField("", text: $form.email)
                    .textFieldStyle(.roundedBorder)
            }
            if let error = form.lastError {
                Text(Self.message(for: error))
                    .foregroundStyle(.red)
            }
            HStack {
                Button(role: .cancel) {
                    form.lastError = nil
                    dismiss()
                } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    viewModel.submitRegistration()
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

    private static func message(for error: RegistrationError) -> LocalizedStringResource {
        switch error {
        case .nicknameExists: return L.resource("Nickname already exists.")
        case .failure: return L.resource("Registration failed.")
        }
    }

    private func isValid(form: RegistrationFormState) -> Bool {
        let identifierCap = SomnioProtocolConstants.maxIdentifierUTF8Bytes
        let passwordCap = SomnioProtocolConstants.maxPasswordUTF8Bytes
        guard !form.nickname.isEmpty, form.nickname.utf8.count <= identifierCap else { return false }
        // The server enforces `password.utf8.count >= minPasswordLength`; mirroring
        // exactly here means a non-ASCII password whose grapheme count is below the
        // floor but whose UTF-8 byte count clears it isn't blocked client-side.
        guard form.password.utf8.count >= minPasswordLength, form.password.utf8.count <= passwordCap else { return false }
        guard form.password == form.passwordRepeat else { return false }
        guard !form.email.isEmpty, form.email.utf8.count <= identifierCap else { return false }
        return true
    }
}
