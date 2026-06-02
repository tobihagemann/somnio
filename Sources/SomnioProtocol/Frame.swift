import Foundation

/// Tag that identifies which `SomnioMessage` variant is in a frame. Tag values are fixed and
/// load-bearing: server and client must agree on the tag→payload mapping. Messages travel as
/// JSON over WebSocket text frames in the shape `{"tag":"<verb>","payload":{...}}`, so the tag
/// is a self-documenting string equal to the case name.
public enum SomnioMessageTag: String, CaseIterable, Sendable, Equatable {
    // C→S
    case login
    case register
    case clientPosition
    case clientSay
    case equipToggle
    case bumpNPC
    case enterPortal

    // S→C
    case hello
    case loginResult
    case registerResult
    case enterSector
    case mainCharacter
    case entity
    case serverPosition
    case serverSay
    case energy
    case dateTick
    case inventory
    case leave
    case adminSay
}
