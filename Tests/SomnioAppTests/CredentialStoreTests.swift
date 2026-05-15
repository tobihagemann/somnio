import Foundation
import SomnioCore
import Testing
@testable import SomnioApp

/// Exercises the file-backend path of `CredentialStore`. The Keychain backend is gated
/// on `BuildEnvironment.useKeychain == true` (release builds and `SOMNIO_USE_KEYCHAIN=1`
/// in debug); these tests cover the dev default where credentials land on disk under
/// Application Support.
///
/// Tests are serialized because every case mutates the same on-disk file under
/// `BuildEnvironment.appSupportDirectory` — running them in parallel would let one
/// case's `delete()` race another case's `save()`.
@Suite(.serialized) struct CredentialStoreTests {
    @Test func `file backend save then load round trips`() throws {
        // The test runs against the live process Application Support directory; clean
        // any prior remembered credential before asserting.
        CredentialStore.delete()
        try #require(BuildEnvironment.useKeychain == false, "test target must run with the file backend")

        try CredentialStore.save(nickname: "alice", password: "secret123")
        let loaded = try #require(CredentialStore.load())
        #expect(loaded.nickname == "alice")
        #expect(loaded.password == "secret123")

        CredentialStore.delete()
        #expect(CredentialStore.load() == nil)
    }

    @Test func `file backend writes credential.json with mode 0600`() throws {
        CredentialStore.delete()
        try #require(BuildEnvironment.useKeychain == false)

        try CredentialStore.save(nickname: "bob", password: "another-secret")
        let url = BuildEnvironment.appSupportDirectory.appendingPathComponent("credential.json", isDirectory: false)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let mode = try #require(attributes[.posixPermissions] as? NSNumber)
        // `0o600` keeps the cleartext password out of every other process running as
        // the same user. `.netrc` and `~/.aws/credentials` use the same convention.
        #expect(mode.intValue == 0o600)
        CredentialStore.delete()
    }

    @Test func `serviceName scopes the keychain account to the build profile`() {
        // The service-string suffix prevents dev/release/profile keychain items from
        // aliasing the same `(service, account)` tuple. Mirrors the security
        // requirement called out in the plan.
        let expectedSuffix = BuildEnvironment.appSupportDirectoryName
        #expect(CredentialStore.serviceName == "de.tobiha.somnio.credentials.\(expectedSuffix)")
    }
}
