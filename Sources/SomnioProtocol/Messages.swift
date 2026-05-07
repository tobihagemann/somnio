import Foundation

/// Top-level discriminated union of every gameplay message the wire protocol can carry.
/// One case per directional message in the spec catalog.
public enum SomnioMessage: Sendable, Equatable {
    // MARK: - C→S

    case login(LoginMessage)
    case register(RegisterMessage)
    case clientPosition(PositionMessage)
    case clientSay(SayMessage)
    case equipToggle(EquipToggleMessage)
    case bumpNPC(BumpNPCMessage)
    case enterPortal(EnterPortalMessage)

    // MARK: - S→C

    case hello(HelloMessage)
    case loginResult(LoginResultMessage)
    case registerResult(RegisterResultMessage)
    case enterSector(EnterSectorMessage)
    case mainCharacter(MainCharacterMessage)
    case entity(EntityMessage)
    case serverPosition(PositionMessage)
    case serverSay(SayMessage)
    case energy(Energy)
    case dateTick(DateTickMessage)
    case inventory(InventoryMessage)
    case leave(LeaveMessage)
    case adminSay(AdminSayMessage)

    public var tag: SomnioMessageTag {
        switch self {
        case .login: return .login
        case .register: return .register
        case .clientPosition: return .clientPosition
        case .clientSay: return .clientSay
        case .equipToggle: return .equipToggle
        case .bumpNPC: return .bumpNPC
        case .enterPortal: return .enterPortal
        case .hello: return .hello
        case .loginResult: return .loginResult
        case .registerResult: return .registerResult
        case .enterSector: return .enterSector
        case .mainCharacter: return .mainCharacter
        case .entity: return .entity
        case .serverPosition: return .serverPosition
        case .serverSay: return .serverSay
        case .energy: return .energy
        case .dateTick: return .dateTick
        case .inventory: return .inventory
        case .leave: return .leave
        case .adminSay: return .adminSay
        }
    }
}
