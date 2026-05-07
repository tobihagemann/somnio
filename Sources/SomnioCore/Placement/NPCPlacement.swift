import Foundation

/// NPC runtime placement helper. The original server centers an NPC inside its spawn box at
/// load time. The port keeps this calculation **outside** `MapCodec.read` so the reader
/// stores the file's authored `spawnOrigin` verbatim and the editor can render at the box
/// origin (preserving round-trip fidelity). Server gameplay-loop code calls this helper
/// when materializing the NPC entity.
public enum NPCPlacement {
    public static func runtimePosition(for npc: NPC) -> GridPoint {
        GridPoint(
            x: npc.spawnOrigin.x + (npc.spawnBoxSize.width - npc.maskSize.width) / 2,
            y: npc.spawnOrigin.y + (npc.spawnBoxSize.height - npc.maskSize.height) / 2
        )
    }
}
