import Foundation
import SomnioData
import Testing
@testable import SomnioServerCore

struct ServerConfigurationTests {
    @Test func `release build with full env resolves every field from the environment`() throws {
        let environment: [String: String] = [
            "SOMNIO_HTTP_HOST": "10.0.0.5",
            "SOMNIO_HTTP_PORT": "9001",
            "SOMNIO_ADMIN_TOKEN": "production-secret",
            "SOMNIO_SECTORS_DIR": "/srv/somnio/maps"
        ]
        let configuration = try ServerConfiguration.resolve(environment: environment, isDebug: false)
        #expect(configuration.httpHost == "10.0.0.5")
        #expect(configuration.httpPort == 9001)
        #expect(configuration.adminToken == "production-secret")
        #expect(configuration.sectorsDirectory.path == "/srv/somnio/maps")
    }

    @Test func `debug build with empty env falls back to dev defaults`() throws {
        let configuration = try ServerConfiguration.resolve(environment: [:], isDebug: true)
        #expect(configuration.httpHost == ServerConfiguration.defaultHttpHost)
        #expect(configuration.httpPort == ServerConfiguration.defaultHttpPort)
        #expect(configuration.adminToken == ServerConfiguration.debugAdminToken)
        #expect(configuration.sectorsDirectory.path.hasSuffix(ServerConfiguration.debugSectorsDirectoryRelativePath))
    }

    @Test func `release build with no admin token throws missingAdminTokenInRelease`() {
        let environment = ["SOMNIO_SECTORS_DIR": "/srv/maps"]
        #expect(throws: ServerStartupError.missingAdminTokenInRelease) {
            _ = try ServerConfiguration.resolve(environment: environment, isDebug: false)
        }
    }

    @Test func `release build with no sectors dir throws missingSectorsDirectoryInRelease`() {
        let environment = ["SOMNIO_ADMIN_TOKEN": "secret"]
        #expect(throws: ServerStartupError.missingSectorsDirectoryInRelease) {
            _ = try ServerConfiguration.resolve(environment: environment, isDebug: false)
        }
    }

    @Test func `non-numeric port throws invalidPort`() {
        let environment = ["SOMNIO_HTTP_PORT": "not-a-port"]
        #expect(throws: ServerStartupError.invalidPort("not-a-port")) {
            _ = try ServerConfiguration.resolve(environment: environment, isDebug: true)
        }
    }

    @Test(arguments: ["0", "65536", "-1", "70000"]) func `out-of-range port throws invalidPort`(_ raw: String) {
        let environment: [String: String] = ["SOMNIO_HTTP_PORT": raw]
        #expect(throws: ServerStartupError.invalidPort(raw)) {
            _ = try ServerConfiguration.resolve(environment: environment, isDebug: true)
        }
    }

    @Test func `empty admin token in release rejected as missing`() {
        let environment: [String: String] = [
            "SOMNIO_ADMIN_TOKEN": "",
            "SOMNIO_SECTORS_DIR": "/srv/maps"
        ]
        #expect(throws: ServerStartupError.missingAdminTokenInRelease) {
            _ = try ServerConfiguration.resolve(environment: environment, isDebug: false)
        }
    }

    @Test(arguments: ["1", "true", "TRUE", "True"]) func `truthy SOMNIO_DIALOG_PRUNE_FORCE resolves forceDialogPrune true`(_ raw: String) throws {
        let environment: [String: String] = ["SOMNIO_DIALOG_PRUNE_FORCE": raw]
        let configuration = try ServerConfiguration.resolve(environment: environment, isDebug: true)
        #expect(configuration.forceDialogPrune)
    }

    @Test(arguments: ["", "0", "false", "no", "yes"]) func `absent or non-truthy SOMNIO_DIALOG_PRUNE_FORCE resolves forceDialogPrune false`(_ raw: String) throws {
        let environment: [String: String] = ["SOMNIO_DIALOG_PRUNE_FORCE": raw]
        let configuration = try ServerConfiguration.resolve(environment: environment, isDebug: true)
        #expect(configuration.forceDialogPrune == false)
    }

    @Test func `absent SOMNIO_DIALOG_PRUNE_FORCE defaults forceDialogPrune false`() throws {
        let configuration = try ServerConfiguration.resolve(environment: [:], isDebug: true)
        #expect(configuration.forceDialogPrune == false)
    }
}
