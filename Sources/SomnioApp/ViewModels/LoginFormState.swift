import Foundation

/// Mutable login-sheet state held by `ClientViewModel`. The view binds to fields here
/// directly via `@Bindable`; submission reads the values and forwards them through the
/// transport.
@Observable public final class LoginFormState {
    public var nickname: String = ""
    public var password: String = ""
    public var rememberPassword: Bool = false

    public init() {}

    public func clear() {
        nickname = ""
        password = ""
        rememberPassword = false
    }
}
