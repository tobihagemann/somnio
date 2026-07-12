import SomnioCore
import SomnioTheme
import SwiftUI

/// Persistent live inspector (top-trailing): edits the selected record's fields in place
/// through `SectorDocument.mutate`, replacing every modal dialog. No selection shows the
/// sector-level summary; a multi-selection shows the count plus the shared actions; a
/// single selection edits every persisted field of its kind — direct placement seeds
/// defaults, so this panel is the only way to refine them.
@MainActor struct InspectorPanelView: View {
    @ObservedObject var document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        FantasyPanel(title: title, fillOpacity: 0.6) {
            VStack(alignment: .leading, spacing: 8) {
                content
            }
        }
        // Constrain the panel itself: the title's divider flanks are greedy
        // (`maxWidth: .infinity`) and would stretch the chrome across the window.
        .frame(width: 300)
    }

    private var title: LocalizedStringResource {
        guard let selected = workspace.selection.first else { return L.resource("Sector") }
        guard workspace.selection.count == 1 else { return L.resource("Selection") }
        switch selected {
        case .object: return L.resource("Object")
        case .mask: return L.resource("Mask")
        case .portal: return L.resource("Sector portal")
        case .npc: return L.resource("NPC")
        case .monsterSpawn: return L.resource("Monster")
        }
    }

    @ViewBuilder private var content: some View {
        if workspace.selection.isEmpty {
            sectorSummary
        } else if workspace.selection.count > 1 {
            multiSelection
        } else if let selected = workspace.selection.first {
            singleSelection(selected)
                // Stable per-record identity: switching selection rebuilds the draft
                // fields so a focused edit can never commit to the wrong record.
                .id(selected)
        }
    }

    // MARK: - Sector summary (no selection)

    @ViewBuilder private var sectorSummary: some View {
        summaryRow(L.resource("Sector name"), document.sectorName)
        summaryRow(L.resource("Width"), "\(document.body.dimensions.width)")
        summaryRow(L.resource("Height"), "\(document.body.dimensions.height)")
        summaryRow(L.resource("Floor material"), document.body.floorMaterialID)
        summaryRow(L.resource("Light"), "\(document.body.light.brightness)")
        Button {
            workspace.presentedOverlay = .sectorSettings
        } label: {
            Text(L.resource("Sector Settings..."))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(FantasyButtonStyle())
        .disabled(document.isUninitialized)
    }

    private func summaryRow(_ title: LocalizedStringResource, _ value: String) -> some View {
        HStack {
            Text(title)
                .frame(width: 96, alignment: .leading)
            Text(verbatim: value)
                .foregroundStyle(FantasyPalette.secondaryText)
        }
    }

    // MARK: - Multi-selection

    @ViewBuilder private var multiSelection: some View {
        Text(verbatim: L.string("\(workspace.selection.count) selected"))
        Button {
            CanvasController.deleteSelection(document: document, workspace: workspace, undoManager: undoManager)
        } label: {
            Text(L.resource("Delete"))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(FantasyButtonStyle())
    }

    // MARK: - Single selection

    @ViewBuilder private func singleSelection(_ selection: EditorSelection) -> some View {
        switch selection {
        case let .object(index):
            if document.body.objects.indices.contains(index) {
                objectFields(index, document.body.objects[index])
            }
        case let .mask(index):
            if document.body.collisionMasks.indices.contains(index) {
                maskFields(index, document.body.collisionMasks[index])
            }
        case let .portal(index):
            if document.body.portals.indices.contains(index) {
                portalFields(index, document.body.portals[index])
            }
        case let .npc(index):
            if document.body.npcs.indices.contains(index) {
                npcFields(index, document.body.npcs[index])
            }
        case let .monsterSpawn(index):
            if document.body.monsterSpawns.indices.contains(index) {
                monsterFields(index, document.body.monsterSpawns[index])
            }
        }
    }

    @ViewBuilder private func objectFields(_ index: Int, _ object: Object) -> some View {
        RegistryIDPicker(
            title: L.resource("Model"),
            ids: EditorDefaults.objectModelIDs,
            selection: binding(object.modelID, edit(\.objects, index, "Edit object") { $0.modelID = $1 })
        )
        InspectorDraftField(L.resource("X"), value: object.x, onCommit: edit(\.objects, index, "Edit object") { $0.x = $1 })
        InspectorDraftField(L.resource("Y"), value: object.y, onCommit: edit(\.objects, index, "Edit object") { $0.y = $1 })
        InspectorDraftField(L.resource("Width"), value: object.sourceWidth, onCommit: edit(\.objects, index, "Edit object") { $0.sourceWidth = $1 })
        InspectorDraftField(L.resource("Height"), value: object.sourceHeight, onCommit: edit(\.objects, index, "Edit object") { $0.sourceHeight = $1 })
        InspectorDraftField(L.resource("Priority"), value: object.priority, onCommit: edit(\.objects, index, "Edit object") { $0.priority = $1 })
    }

    @ViewBuilder private func maskFields(_ index: Int, _ mask: CollisionMask) -> some View {
        InspectorDraftField(L.resource("X"), value: mask.x, onCommit: edit(\.collisionMasks, index, "Edit collision mask") { $0.x = $1 })
        InspectorDraftField(L.resource("Y"), value: mask.y, onCommit: edit(\.collisionMasks, index, "Edit collision mask") { $0.y = $1 })
        InspectorDraftField(L.resource("Width"), value: mask.width, onCommit: edit(\.collisionMasks, index, "Edit collision mask") { $0.width = $1 })
        InspectorDraftField(L.resource("Height"), value: mask.height, onCommit: edit(\.collisionMasks, index, "Edit collision mask") { $0.height = $1 })
    }

    @ViewBuilder private func portalFields(_ index: Int, _ portal: SectorPortal) -> some View {
        InspectorDraftField(L.resource("X"), value: portal.x, onCommit: edit(\.portals, index, "Edit sector portal") { $0.x = $1 })
        InspectorDraftField(L.resource("Y"), value: portal.y, onCommit: edit(\.portals, index, "Edit sector portal") { $0.y = $1 })
        InspectorDraftField(L.resource("Width"), value: portal.width, onCommit: edit(\.portals, index, "Edit sector portal") { $0.width = $1 })
        InspectorDraftField(L.resource("Height"), value: portal.height, onCommit: edit(\.portals, index, "Edit sector portal") { $0.height = $1 })
        InspectorDraftField(L.resource("Target sector"), value: portal.targetSectorName, onCommit: edit(\.portals, index, "Edit sector portal") { $0.targetSectorName = $1 })
        Picker(selection: binding(portal.direction, edit(\.portals, index, "Edit sector portal") { $0.direction = $1 })) {
            ForEach(PortalDirection.allCases, id: \.rawValue) { direction in
                Text(Self.label(for: direction)).tag(direction)
            }
        } label: {
            Text(L.resource("Direction"))
        }
    }

    @ViewBuilder private func npcFields(_ index: Int, _ npc: NPC) -> some View {
        InspectorDraftField(L.resource("Name"), value: npc.name, onCommit: edit(\.npcs, index, "Edit NPC") { $0.name = $1 })
        InspectorDraftField(L.resource("Figure"), value: npc.figure, onCommit: edit(\.npcs, index, "Edit NPC") { $0.figure = $1 })
        InspectorDraftField(L.resource("X"), value: npc.spawnOrigin.x, onCommit: edit(\.npcs, index, "Edit NPC") { $0.spawnOrigin.x = $1 })
        InspectorDraftField(L.resource("Y"), value: npc.spawnOrigin.y, onCommit: edit(\.npcs, index, "Edit NPC") { $0.spawnOrigin.y = $1 })
        InspectorDraftField(L.resource("Box width"), value: npc.spawnBoxSize.width, onCommit: edit(\.npcs, index, "Edit NPC") { $0.spawnBoxSize.width = $1 })
        InspectorDraftField(L.resource("Box height"), value: npc.spawnBoxSize.height, onCommit: edit(\.npcs, index, "Edit NPC") { $0.spawnBoxSize.height = $1 })
        InspectorDraftField(L.resource("Mask width"), value: npc.maskSize.width, onCommit: edit(\.npcs, index, "Edit NPC") { $0.maskSize.width = $1 })
        InspectorDraftField(L.resource("Mask height"), value: npc.maskSize.height, onCommit: edit(\.npcs, index, "Edit NPC") { $0.maskSize.height = $1 })
        InspectorDraftField(L.resource("Facing"), value: npc.facing.degrees, onCommit: edit(\.npcs, index, "Edit NPC") { $0.facing = Heading(degrees: $1) })
        InspectorDraftField(L.resource("Behavior"), value: npc.behaviorTag, onCommit: edit(\.npcs, index, "Edit NPC") { $0.behaviorTag = $1 })
        Text(L.resource("Only behaviorTag 0 (greeter) is implemented server-side; other values fall through."))
            .font(.caption)
            .foregroundStyle(FantasyPalette.secondaryText)
        InspectorScriptField(value: npc.dialogScript, onCommit: edit(\.npcs, index, "Edit NPC") { $0.dialogScript = $1 })
    }

    @ViewBuilder private func monsterFields(_ index: Int, _ spawn: MonsterSpawn) -> some View {
        InspectorDraftField(L.resource("Name"), value: spawn.name, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.name = $1 })
        InspectorDraftField(L.resource("Figure"), value: spawn.figure, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.figure = $1 })
        InspectorDraftField(L.resource("X"), value: spawn.spawnOrigin.x, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnOrigin.x = $1 })
        InspectorDraftField(L.resource("Y"), value: spawn.spawnOrigin.y, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnOrigin.y = $1 })
        InspectorDraftField(L.resource("Box width"), value: spawn.spawnBoxSize.width, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnBoxSize.width = $1 })
        InspectorDraftField(L.resource("Box height"), value: spawn.spawnBoxSize.height, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnBoxSize.height = $1 })
        InspectorDraftField(L.resource("Monster width"), value: spawn.spawnedMonsterSize.width, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnedMonsterSize.width = $1 })
        InspectorDraftField(L.resource("Monster height"), value: spawn.spawnedMonsterSize.height, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnedMonsterSize.height = $1 })
        Picker(selection: binding(spawn.bounded, edit(\.monsterSpawns, index, "Edit monster spawn") { $0.bounded = $1 })) {
            Text(L.resource("Yes")).tag(true)
            Text(L.resource("No")).tag(false)
        } label: {
            Text(L.resource("Bounded"))
        }
        InspectorDraftField(L.resource("Spawn HP"), value: spawn.spawnHP, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnHP = $1 })
        InspectorDraftField(L.resource("Spawn balance"), value: spawn.spawnBalance, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnBalance = $1 })
        InspectorDraftField(L.resource("Spawn mana"), value: spawn.spawnMana, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.spawnMana = $1 })
        InspectorDraftField(L.resource("Script index"), value: spawn.aiScriptIndex, onCommit: edit(\.monsterSpawns, index, "Edit monster spawn") { $0.aiScriptIndex = $1 })
    }

    // MARK: - Commit plumbing

    /// Discrete controls (pickers, toggles) commit directly through this `mutate`-backed
    /// binding — each change is already one discrete undo step. Text fields go through
    /// the draft fields instead so keystrokes never hit the undo stack.
    private func binding<T: Equatable>(_ current: T, _ commit: @escaping (T) -> Void) -> Binding<T> {
        Binding(
            get: { current },
            set: { newValue in
                guard newValue != current else { return }
                commit(newValue)
            }
        )
    }

    /// One `mutate`-backed commit closure per record array, generic over the keypath so
    /// each record kind doesn't repeat the guard-and-write boilerplate.
    private func edit<Record, Value>(
        _ records: WritableKeyPath<SectorBody, [Record]>,
        _ index: Int,
        _ description: String.LocalizationValue,
        _ change: @escaping (inout Record, Value) -> Void
    ) -> (Value) -> Void {
        { newValue in
            document.mutate(description, undoManager: undoManager) { body in
                guard body[keyPath: records].indices.contains(index) else { return }
                change(&body[keyPath: records][index], newValue)
            }
        }
    }

    private static func label(for direction: PortalDirection) -> LocalizedStringResource {
        switch direction {
        case .outboundTrigger: return L.resource("Outbound trigger")
        case .arrivalPlacement: return L.resource("Arrival placement")
        }
    }
}
