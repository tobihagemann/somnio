import Foundation

public struct NPCDialogState: Sendable, Equatable, Hashable {
    public var sectorName: String
    public var npcIndex: Int16
    public var scriptStep: Int16

    public init(sectorName: String, npcIndex: Int16, scriptStep: Int16) {
        self.sectorName = sectorName
        self.npcIndex = npcIndex
        self.scriptStep = scriptStep
    }
}
