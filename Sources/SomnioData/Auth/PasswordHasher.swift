import CArgon2
import Foundation
import Logging

/// OWASP-tier Argon2id parameters used to hash and verify passwords. The default values
/// match the middle tier in OWASP's Password Storage Cheat Sheet (one of five equivalent
/// tiers); pick a higher-memory tier in production if hardware budget allows.
///
/// Reference: <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>.
public struct Argon2Parameters: Sendable {
    public let memoryCostKiB: UInt32
    public let iterations: UInt32
    public let parallelism: UInt32

    public init(memoryCostKiB: UInt32, iterations: UInt32, parallelism: UInt32) {
        self.memoryCostKiB = memoryCostKiB
        self.iterations = iterations
        self.parallelism = parallelism
    }

    public static let `default` = Argon2Parameters(
        memoryCostKiB: 19456,
        iterations: 2,
        parallelism: 1
    )
}

/// Argon2id-backed password hasher. Wraps the C reference library through the `CArgon2`
/// SwiftPM system-library target. The encoded form is a self-describing PHC string
/// (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`) so `verify` does not need the
/// original parameters threaded through alongside.
///
/// Both `hash` and `verify` route the C call through `Task.detached` so the cooperative
/// thread pool isn't pinned for the ~50–100 ms of CPU work an Argon2id call costs at
/// OWASP-tier parameters. Concurrent logins therefore don't stall unrelated tasks.
public struct PasswordHasher: Sendable {
    private let parameters: Argon2Parameters
    private let logger: Logger

    public init(parameters: Argon2Parameters = .default, logger: Logger) {
        self.parameters = parameters
        self.logger = logger
    }

    public func hash(_ rawPassword: String) async throws -> String {
        let parameters = parameters
        let logger = logger
        let task: Task<String, any Error> = Task.detached(priority: .userInitiated) {
            let salt = makeSalt()
            let passwordBytes = Array(rawPassword.utf8)
            let encodedLength = argon2_encodedlen(
                parameters.iterations,
                parameters.memoryCostKiB,
                parameters.parallelism,
                UInt32(salt.count),
                UInt32(hashByteCount),
                Argon2_id
            )
            var encodedBuffer = [CChar](repeating: 0, count: encodedLength)

            let resultCode = passwordBytes.withUnsafeBufferPointer { passwordPointer in
                salt.withUnsafeBufferPointer { saltPointer in
                    argon2id_hash_encoded(
                        parameters.iterations,
                        parameters.memoryCostKiB,
                        parameters.parallelism,
                        passwordPointer.baseAddress,
                        passwordBytes.count,
                        saltPointer.baseAddress,
                        salt.count,
                        hashByteCount,
                        &encodedBuffer,
                        encodedLength
                    )
                }
            }
            guard resultCode == argon2OK else {
                throw PasswordHasherError.argon2(code: resultCode, message: errorMessage(for: resultCode))
            }
            logger.debug("hashed password")
            return String(cString: encodedBuffer)
        }
        return try await task.value
    }

    public func verify(_ rawPassword: String, against encodedHash: String) async throws -> Bool {
        let logger = logger
        let task: Task<Bool, any Error> = Task.detached(priority: .userInitiated) {
            let passwordBytes = Array(rawPassword.utf8)
            let resultCode = encodedHash.withCString { encodedPointer in
                passwordBytes.withUnsafeBufferPointer { passwordPointer in
                    argon2id_verify(encodedPointer, passwordPointer.baseAddress, passwordBytes.count)
                }
            }
            switch resultCode {
            case argon2OK:
                logger.debug("verified password")
                return true
            case argon2VerifyMismatch:
                logger.debug("verified password")
                return false
            default:
                throw PasswordHasherError.argon2(code: resultCode, message: errorMessage(for: resultCode))
            }
        }
        return try await task.value
    }
}

/// `<argon2.h>` declares the result codes as a C enum (`Argon2_ErrorCodes`), but the
/// hash/verify functions return `int`. The Swift importer surfaces both, so callers compare
/// against the `Int32` raw value of the enum case.
private let argon2OK: Int32 = .init(ARGON2_OK.rawValue)
private let argon2VerifyMismatch: Int32 = .init(ARGON2_VERIFY_MISMATCH.rawValue)

/// 16-byte salts per the OWASP Password Storage Cheat Sheet recommendation. The C library's
/// only documented floor is `ARGON2_MIN_SALT_LENGTH = 8`, so the choice is ours; Apple
/// documents `SystemRandomNumberGenerator` as cryptographically secure on every Swift
/// platform (https://developer.apple.com/documentation/swift/systemrandomnumbergenerator).
private let saltByteCount: Int = 16
private let hashByteCount: Int = 32

private func makeSalt() -> [UInt8] {
    (0 ..< saltByteCount).map { _ in UInt8.random(in: 0 ... UInt8.max) }
}

private func errorMessage(for code: Int32) -> String {
    guard let pointer = argon2_error_message(code) else { return "argon2 error \(code)" }
    return String(cString: pointer)
}

public enum PasswordHasherError: Error, Sendable, Equatable {
    case argon2(code: Int32, message: String)
}
