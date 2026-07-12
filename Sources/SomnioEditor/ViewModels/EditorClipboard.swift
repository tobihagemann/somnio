import Foundation
import SomnioCore
import UniformTypeIdentifiers

/// Copied record values, grouped per `SectorBody` array. Serialized as JSON onto the
/// system pasteboard (under `UTType.somnioEditorRecords`) so ⌘C/⌘V ride the standard Edit
/// menu via `onCopyCommand`/`onPasteCommand` — a focused inspector text field keeps its
/// own text copy/paste, and a second editor window can receive the records.
public struct EditorClipboard: Codable, Sendable, Equatable {
    public var objects: [Object] = []
    public var collisionMasks: [CollisionMask] = []
    public var portals: [SectorPortal] = []
    public var npcs: [NPC] = []
    public var monsterSpawns: [MonsterSpawn] = []

    public init() {}

    public var isEmpty: Bool {
        objects.isEmpty && collisionMasks.isEmpty && portals.isEmpty && npcs.isEmpty && monsterSpawns.isEmpty
    }

    /// Snapshots every selected record's value (stale indices are skipped) in ascending
    /// source-array order — insertion appends each array verbatim and picking treats later
    /// records as topmost, so a set-ordered capture would shuffle overlapping records'
    /// stacking on paste.
    public static func capture(_ selections: Set<EditorSelection>, from body: SectorBody) -> EditorClipboard {
        var clipboard = EditorClipboard()
        for selection in selections.sorted(by: { $0.sourceIndex < $1.sourceIndex }) {
            guard selection.isValid(in: body) else { continue }
            switch selection {
            case let .object(index):
                clipboard.objects.append(body.objects[index])
            case let .mask(index):
                clipboard.collisionMasks.append(body.collisionMasks[index])
            case let .portal(index):
                clipboard.portals.append(body.portals[index])
            case let .npc(index):
                clipboard.npcs.append(body.npcs[index])
            case let .monsterSpawn(index):
                clipboard.monsterSpawns.append(body.monsterSpawns[index])
            }
        }
        return clipboard
    }

    /// The full paste gate as one pure step: bounds the raw bytes before decoding, inserts
    /// at the anchor, and accepts only a body `MapCodec.write` round-trips — its content
    /// counts and encoded-size caps included — so a paste (from the untrusted system
    /// pasteboard) can never wedge the document into a state its own writer refuses to
    /// save. Returns the pasted body plus the clones' selections, or `nil` on rejection.
    public static func validatedPaste(
        data: Data,
        into body: SectorBody,
        anchor: GridPoint?,
        fallbackOffset: Int16
    ) -> (body: SectorBody, selection: Set<EditorSelection>)? {
        guard data.count <= SomnioConstants.maxSectorFileBytes,
              let clipboard = try? JSONDecoder().decode(EditorClipboard.self, from: data),
              !clipboard.isEmpty
        else { return nil }
        var candidate = body
        let inserted = clipboard.inserting(into: &candidate, anchor: anchor, fallbackOffset: fallbackOffset)
        guard (try? MapCodec.write(candidate)) != nil else { return nil }
        return (candidate, inserted)
    }

    /// Appends clones of every carried record, shifted as a group: with an `anchor` the
    /// payload's top-left bounding corner lands there (paste-at-cursor); without one every
    /// origin shifts by `fallbackOffset` on both axes (duplicate). Returns the selections
    /// of the inserted clones. All offset arithmetic widens to `Int32` and clamps back.
    @discardableResult
    public func inserting(into body: inout SectorBody, anchor: GridPoint?, fallbackOffset: Int16) -> Set<EditorSelection> {
        guard !isEmpty else { return [] }
        let shift: (dx: Int32, dy: Int32) = if let anchor, let minOrigin = boundingOrigin {
            (Int32(anchor.x) - minOrigin.x, Int32(anchor.y) - minOrigin.y)
        } else {
            (Int32(fallbackOffset), Int32(fallbackOffset))
        }
        var inserted: Set<EditorSelection> = []
        for var object in objects {
            object.x = Int16(clamping: Int32(object.x) + shift.dx)
            object.y = Int16(clamping: Int32(object.y) + shift.dy)
            body.objects.append(object)
            inserted.insert(.object(body.objects.count - 1))
        }
        for var mask in collisionMasks {
            mask.x = Int16(clamping: Int32(mask.x) + shift.dx)
            mask.y = Int16(clamping: Int32(mask.y) + shift.dy)
            body.collisionMasks.append(mask)
            inserted.insert(.mask(body.collisionMasks.count - 1))
        }
        for var portal in portals {
            portal.x = Int16(clamping: Int32(portal.x) + shift.dx)
            portal.y = Int16(clamping: Int32(portal.y) + shift.dy)
            body.portals.append(portal)
            inserted.insert(.portal(body.portals.count - 1))
        }
        for var npc in npcs {
            npc.spawnOrigin = Self.shifted(npc.spawnOrigin, by: shift)
            body.npcs.append(npc)
            inserted.insert(.npc(body.npcs.count - 1))
        }
        for var spawn in monsterSpawns {
            spawn.spawnOrigin = Self.shifted(spawn.spawnOrigin, by: shift)
            body.monsterSpawns.append(spawn)
            inserted.insert(.monsterSpawn(body.monsterSpawns.count - 1))
        }
        return inserted
    }

    /// Top-left corner of the payload's bounding box (in `Int32` so extreme origins never
    /// trap), or `nil` for an empty payload.
    var boundingOrigin: (x: Int32, y: Int32)? {
        var minX: Int32?
        var minY: Int32?
        func fold(x: Int16, y: Int16) {
            minX = min(minX ?? Int32(x), Int32(x))
            minY = min(minY ?? Int32(y), Int32(y))
        }
        for object in objects {
            fold(x: object.x, y: object.y)
        }
        for mask in collisionMasks {
            fold(x: mask.x, y: mask.y)
        }
        for portal in portals {
            fold(x: portal.x, y: portal.y)
        }
        for npc in npcs {
            fold(x: npc.spawnOrigin.x, y: npc.spawnOrigin.y)
        }
        for spawn in monsterSpawns {
            fold(x: spawn.spawnOrigin.x, y: spawn.spawnOrigin.y)
        }
        guard let minX, let minY else { return nil }
        return (minX, minY)
    }

    private static func shifted(_ point: GridPoint, by shift: (dx: Int32, dy: Int32)) -> GridPoint {
        GridPoint(
            x: Int16(clamping: Int32(point.x) + shift.dx),
            y: Int16(clamping: Int32(point.y) + shift.dy)
        )
    }
}

public extension UTType {
    /// Pasteboard type for copied editor records (JSON-encoded `EditorClipboard`).
    /// Process-local by declaration but pasteboard-portable between editor windows.
    static let somnioEditorRecords = UTType(exportedAs: "de.tobiha.somnio.editor.records", conformingTo: .json)
}
