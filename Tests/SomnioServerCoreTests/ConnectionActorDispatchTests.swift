import Foundation
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Wire-protocol close-enforcement sentinel for `ConnectionActor.dispatch`. Every message that
/// is illegal for the current connection state must return `.close(.protocolError, ...)`:
/// a server-only tag arriving from a client, a client gameplay tag before login, or a
/// `login`/`register` after the connection is already attached.
///
/// Coverage asymmetry, recorded deliberately: this suite asserts the close branches *still
/// close*. It does not cover the keep-open branches (`.login`/`.register` pre-login,
/// gameplay tags post-attach) — those run the real `LoginHandler`/`RegisterHandler`/
/// `GameplayHandlers` with side effects (enqueuing result frames, touching the sector/router)
/// out of a close-branch sentinel's scope. So this guards "the close set keeps closing", not
/// "the keep-open set stays keep-open"; a tag migrating *into* a keep-open branch would slip
/// past it.
struct ConnectionActorDispatchTests {
    struct DispatchCloseCase: CustomTestStringConvertible {
        let message: SomnioMessage
        let attachFirst: Bool
        let label: String

        var testDescription: String {
            label
        }
    }

    @Test(arguments: dispatchCloseCases)
    func `dispatch closes with protocolError for state-illegal tags`(_ testCase: DispatchCloseCase) async throws {
        let connection = try await ConnectionActor(dependencies: makeStubConnectionDependencies())
        if testCase.attachFirst {
            await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: UUID())
        }

        let decision = await connection.dispatch(testCase.message, frameSize: 0)

        guard case .close(.protocolError, _) = decision else {
            Issue.record("expected .close(.protocolError, _) for \(testCase.label), got \(decision)")
            return
        }
    }
}

// MARK: - Cases + sample payloads (mirroring Tests/SomnioProtocolTests/RoundTripTests.swift)

private typealias Case = ConnectionActorDispatchTests.DispatchCloseCase

private let samplePosition = PositionMessage(entityIndex: 7, x: 10, y: 20, facing: 1, tempo: 2)
private let sampleSay = SayMessage(entityIndex: 0, text: "Hallo Welt")
private let sampleLeave = LeaveMessage(entityIndex: 4, leftGame: true)
private let sampleEntity = EntityMessage(
    entityIndex: 9, figure: 0, gender: 1, maskWidth: 32, maskHeight: 48,
    type: .player, name: "Libus", x: 10, y: 12, facing: 0, tempo: 2
)
private let sampleRegister = RegisterMessage(
    nickname: "Saibot", password: "p", passwordRepeat: "p",
    characterClass: 0, gender: 1, email: "info@example.com"
)

private let dispatchCloseCases: [Case] = [
    // awaitingLogin + server-only tag.
    Case(message: .serverPosition(samplePosition), attachFirst: false, label: "pre-login serverPosition"),
    Case(message: .entity(sampleEntity), attachFirst: false, label: "pre-login entity"),
    Case(message: .hello(HelloMessage(protocolVersion: 1)), attachFirst: false, label: "pre-login hello"),
    Case(message: .leave(sampleLeave), attachFirst: false, label: "pre-login leave"),
    // awaitingLogin + client gameplay tag.
    Case(message: .clientPosition(samplePosition), attachFirst: false, label: "pre-login clientPosition"),
    Case(message: .clientSay(sampleSay), attachFirst: false, label: "pre-login clientSay"),
    Case(message: .equipToggle(EquipToggleMessage(slot: 1, hand: .left)), attachFirst: false, label: "pre-login equipToggle"),
    Case(message: .bumpNPC(BumpNPCMessage(npcIndex: 4)), attachFirst: false, label: "pre-login bumpNPC"),
    Case(message: .enterPortal(EnterPortalMessage(portalIndex: 2)), attachFirst: false, label: "pre-login enterPortal"),
    // attached + login/register.
    Case(message: .login(LoginMessage(nickname: "n", password: "p")), attachFirst: true, label: "post-attach login"),
    Case(message: .register(sampleRegister), attachFirst: true, label: "post-attach register"),
    // attached + server-only tag.
    Case(message: .serverPosition(samplePosition), attachFirst: true, label: "post-attach serverPosition"),
    Case(message: .entity(sampleEntity), attachFirst: true, label: "post-attach entity"),
    Case(message: .leave(sampleLeave), attachFirst: true, label: "post-attach leave")
]
