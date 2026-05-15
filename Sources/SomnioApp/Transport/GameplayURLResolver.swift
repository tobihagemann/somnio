import Foundation
import SomnioCore

/// Resolves the gameplay endpoint URL the client should connect to. Debug builds let
/// `SOMNIO_SERVER_URL` override `GameplayDebugDefaults.websocketURL`, but the override
/// is restricted to loopback hostnames so a tampered shell profile cannot redirect the
/// client to a credential-harvesting endpoint. Release builds always use the
/// compile-time literal in `GameplayServerURL.swift`. Throws
/// `SecureTransportValidationError` on any rejection — the validator is the single
/// source of truth for the gate, so the resolver does not wrap or rename its errors.
enum GameplayURLResolver {
    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> String {
        #if DEBUG
            if let envValue = environment["SOMNIO_SERVER_URL"] {
                // The env-var override is constrained to loopback (regardless of
                // scheme) so a poisoned shell profile cannot redirect the client.
                try SecureTransportValidator.validateLoopbackOnly(envValue)
                return envValue
            }
            try SecureTransportValidator.validate(GameplayDebugDefaults.websocketURL)
            return GameplayDebugDefaults.websocketURL
        #else
            try SecureTransportValidator.validate(gameplayProductionURL)
            return gameplayProductionURL
        #endif
    }
}
