import Foundation
import SomnioCore
import Testing
@testable import SomnioEditor

struct EditorSelectionTests {
    private static let body: SectorBody = .init(
        version: 1,
        dimensions: GridSize(width: 4, height: 4),
        ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
        light: LightSetting(indoor: false, brightness: 100),
        objects: [
            Object(x: 0, y: 0, tilesetIndex: 0, sourceX: 0, sourceY: 0,
                   sourceWidth: 32, sourceHeight: 32, priority: 0)
        ],
        collisionMasks: [CollisionMask(x: 0, y: 0, width: 32, height: 32)],
        portals: [SectorPortal(x: 0, y: 0, width: 32, height: 32,
                               targetSectorName: "Other", direction: .outboundTrigger)],
        npcs: [NPC(spawnOrigin: GridPoint(x: 1, y: 1),
                   spawnBoxSize: GridSize(width: 16, height: 16),
                   maskSize: GridSize(width: 8, height: 8),
                   name: "N", figure: 0, facing: Heading(cardinal: .south), behaviorTag: 0,
                   dialogScript: "")],
        monsterSpawns: [MonsterSpawn(spawnOrigin: GridPoint(x: 2, y: 2),
                                     spawnBoxSize: GridSize(width: 16, height: 16),
                                     spawnedMonsterSize: GridSize(width: 8, height: 8),
                                     name: "M", figure: 0, bounded: true,
                                     spawnHP: 1, spawnBalance: 1, spawnMana: 1,
                                     aiScriptIndex: 0)]
    )

    @Test(arguments: [
        EditorSelection.object(0),
        .mask(0),
        .portal(0),
        .npc(0),
        .monsterSpawn(0)
    ])
    func `valid selection reports isValid and resolves bounds`(_ selection: EditorSelection) {
        #expect(selection.isValid(in: Self.body))
        #expect(selection.bounds(in: Self.body) != nil)
    }

    @Test(arguments: [
        EditorSelection.object(99),
        .mask(99),
        .portal(99),
        .npc(99),
        .monsterSpawn(99)
    ])
    func `out-of-range selection reports invalid and resolves no bounds`(_ selection: EditorSelection) {
        #expect(!selection.isValid(in: Self.body))
        #expect(selection.bounds(in: Self.body) == nil)
    }

    @Test func `remove returns true for valid index and removes the record`() {
        var body = Self.body
        let removed = EditorSelection.object(0).remove(from: &body)
        #expect(removed)
        #expect(body.objects.isEmpty)
    }

    @Test func `remove returns false for stale index and leaves body unchanged`() {
        var body = Self.body
        let before = body
        let removed = EditorSelection.npc(99).remove(from: &body)
        #expect(!removed)
        #expect(body == before)
    }

    @Test func `remove from inout body covers every case`() {
        let selections: [EditorSelection] = [
            .object(0), .mask(0), .portal(0), .npc(0), .monsterSpawn(0)
        ]
        for selection in selections {
            var body = Self.body
            #expect(selection.remove(from: &body))
        }
    }
}
