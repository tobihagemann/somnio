import Foundation
import Logging
import Security
import SomnioCore

/// "Remember password" persisted credential. Stored in the macOS Keychain in release
/// builds (and in debug when `SOMNIO_USE_KEYCHAIN=1`); otherwise written as plain JSON
/// under `BuildEnvironment.appSupportDirectory` so dev runs can be reset without the
/// system Keychain UI.
public struct SavedCredential: Codable, Sendable, Equatable {
    public var nickname: String
    public var password: String

    public init(nickname: String, password: String) {
        self.nickname = nickname
        self.password = password
    }
}

/// Keychain (or file-backed) store for the player's "remember password" credential.
/// The service-string scope includes `BuildEnvironment.appSupportDirectoryName` so dev
/// (`Somnio-Dev` / `Somnio-Dev-<profile>`) and release (`Somnio`) Keychain items never
/// alias the same `(service, account)` tuple.
public enum CredentialStore {
    private static let logger = Logger(label: "de.tobiha.somnio.app.credentials")
    private static let credentialFileName = "credential.json"

    public static var serviceName: String {
        "de.tobiha.somnio.credentials.\(BuildEnvironment.appSupportDirectoryName)"
    }

    public static func save(nickname: String, password: String) throws {
        if BuildEnvironment.useKeychain {
            try saveToKeychain(nickname: nickname, password: password)
        } else {
            try saveToFile(nickname: nickname, password: password)
        }
    }

    public static func load() -> SavedCredential? {
        if BuildEnvironment.useKeychain {
            return loadFromKeychain()
        } else {
            return loadFromFile()
        }
    }

    public static func delete() {
        if BuildEnvironment.useKeychain {
            deleteFromKeychain()
        } else {
            deleteFile()
        }
    }

    // MARK: - Keychain backend

    private static func saveToKeychain(nickname: String, password: String) throws {
        guard let passwordData = password.data(using: .utf8) else { return }
        // Drop any existing credential under this service before writing the new one.
        // Without this, switching from `alice` to `bob` would write a SECOND keychain
        // item under the same service (different `kSecAttrAccount`), and the next
        // `loadFromKeychain()` call (which uses `kSecMatchLimitOne`) would return one
        // of the two in unspecified order. The contract is "one remembered credential
        // per profile"; enforce it by clearing every prior item before adding.
        deleteFromKeychain()

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: nickname,
            kSecUseDataProtectionKeychain as String: true,
            kSecValueData as String: passwordData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw CredentialStoreError.keychain(status)
        }
    }

    private static func loadFromKeychain() -> SavedCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let item = result as? [String: Any],
                  let account = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data,
                  let password = String(data: data, encoding: .utf8)
            else { return nil }
            return SavedCredential(nickname: account, password: password)
        case errSecItemNotFound:
            return nil
        case errSecInteractionNotAllowed:
            logger.warning("keychain read deferred: interaction not allowed")
            return nil
        default:
            logger.warning("keychain read failed", metadata: ["status": "\(status)"])
            return nil
        }
    }

    private static func deleteFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecUseDataProtectionKeychain as String: true
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            logger.warning("keychain delete failed", metadata: ["status": "\(status)"])
        }
    }

    // MARK: - File backend (debug-only fallback)

    private static var credentialFileURL: URL {
        BuildEnvironment.appSupportDirectory.appendingPathComponent(credentialFileName, isDirectory: false)
    }

    private static func saveToFile(nickname: String, password: String) throws {
        let directory = BuildEnvironment.appSupportDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload = SavedCredential(nickname: nickname, password: password)
        let data = try JSONEncoder().encode(payload)
        // Create the file via `FileManager.createFile(atPath:contents:attributes:)` so the
        // restrictive `0o600` mode is set at the same syscall as the file's existence —
        // `Data.write(to:options:[.atomic])` followed by a `setAttributes` call would
        // expose a TOCTOU window where the cleartext credential is briefly world-readable
        // between rename and chmod.
        let path = credentialFileURL.path
        let created = FileManager.default.createFile(
            atPath: path,
            contents: data,
            attributes: [.posixPermissions: NSNumber(value: 0o600)]
        )
        guard created else {
            throw CredentialStoreError.fileWriteFailed(path)
        }
    }

    private static func loadFromFile() -> SavedCredential? {
        let url = credentialFileURL
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(SavedCredential.self, from: data)
        } catch {
            logger.warning("file credential read failed", metadata: ["error": "\(error)"])
            return nil
        }
    }

    private static func deleteFile() {
        let url = credentialFileURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            logger.warning("file credential delete failed", metadata: ["error": "\(error)"])
        }
    }
}

public enum CredentialStoreError: Error, Equatable, Sendable {
    case keychain(OSStatus)
    case fileWriteFailed(String)
}
