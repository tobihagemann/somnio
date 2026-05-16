import SomnioCore
import SwiftUI

/// Spawn placement dialog. Combined NPC + monster-spawn surface — the legacy editor
/// split these into two windows but the wire-format records sit in adjacent
/// `SectorBody` arrays, so a single dialog with a variant picker keeps the authoring
/// flow flat.
@MainActor struct SpawnDialogView: View {
    let document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.undoManager) private var undoManager
    @State private var isPresentingScript = false

    var body: some View {
        @Bindable var form = workspace.spawnForm
        return Form {
            Picker(selection: $form.variant) {
                Text(L.resource("NPC")).tag(EditorSpawnVariant.npc)
                Text(L.resource("Monster")).tag(EditorSpawnVariant.monster)
            } label: {
                Text(L.resource("Type"))
            }
            Stepper(value: $form.figure, in: 0 ... Int16.max) {
                StepperLabel(title: L.resource("Figure"), value: form.figure)
            }
            HStack {
                Text(L.resource("Name"))
                TextField("", text: $form.name)
                    .textFieldStyle(.roundedBorder)
            }
            switch form.variant {
            case .npc:
                npcFields(form: form)
            case .monster:
                monsterFields(form: form)
            }
            if let validation = validationMessage(form: form) {
                Text(validation)
                    .foregroundStyle(.red)
            }
            HStack {
                Button(role: .cancel) { dismiss() } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button {
                    switch form.variant {
                    case .npc:
                        let npc = form.buildNPC()
                        document.mutate("Place NPC", undoManager: undoManager) { body in
                            body.npcs.append(npc)
                        }
                    case .monster:
                        let spawn = form.buildMonsterSpawn()
                        document.mutate("Place monster spawn", undoManager: undoManager) { body in
                            body.monsterSpawns.append(spawn)
                        }
                    }
                    dismiss()
                } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(validationMessage(form: form) != nil)
            }
        }
        .padding(20)
        .frame(width: 400)
        .sheet(isPresented: $isPresentingScript) {
            SpawnScriptDialogView(form: workspace.spawnForm)
        }
    }

    @ViewBuilder
    private func npcFields(form: SpawnFormState) -> some View {
        @Bindable var bindable = form
        Picker(selection: $bindable.direction) {
            ForEach(Direction.allCases, id: \.rawValue) { direction in
                Text(Self.label(for: direction)).tag(direction)
            }
        } label: {
            Text(L.resource("Direction"))
        }
        Stepper(value: $bindable.behaviorTag, in: 0 ... Int16.max) {
            StepperLabel(title: L.resource("Behavior"), value: form.behaviorTag)
        }
        Text(L.resource("Only behaviorTag 0 (greeter) is implemented server-side; other values fall through."))
            .font(.caption)
            .foregroundStyle(.secondary)
        // Present the script editor as a nested sheet so dismissing it returns the
        // user to this in-flight spawn dialog instead of unwinding to the canvas
        // and losing the typed-in NPC fields.
        Button {
            isPresentingScript = true
        } label: {
            Text(L.resource("Edit script..."))
        }
    }

    @ViewBuilder
    private func monsterFields(form: SpawnFormState) -> some View {
        @Bindable var bindable = form
        Picker(selection: $bindable.bounded) {
            Text(L.resource("Yes")).tag(true)
            Text(L.resource("No")).tag(false)
        } label: {
            Text(L.resource("Bounded"))
        }
        Stepper(value: $bindable.spawnHP, in: 0 ... Int16.max) {
            StepperLabel(title: L.resource("Spawn HP"), value: form.spawnHP)
        }
        Stepper(value: $bindable.spawnBalance, in: 0 ... Int16.max) {
            StepperLabel(title: L.resource("Spawn balance"), value: form.spawnBalance)
        }
        Stepper(value: $bindable.spawnMana, in: 0 ... Int16.max) {
            StepperLabel(title: L.resource("Spawn mana"), value: form.spawnMana)
        }
        Stepper(value: $bindable.aiScriptIndex, in: 0 ... Int16.max) {
            StepperLabel(title: L.resource("Script index"), value: form.aiScriptIndex)
        }
    }

    private static func label(for direction: Direction) -> LocalizedStringResource {
        switch direction {
        case .north: return L.resource("Direction.north")
        case .east: return L.resource("Direction.east")
        case .south: return L.resource("Direction.south")
        case .west: return L.resource("Direction.west")
        }
    }

    private func validationMessage(form: SpawnFormState) -> LocalizedStringResource? {
        switch form.variant {
        case .npc:
            if form.name.isEmpty { return L.resource("Fill in NPC name!") }
            return nil
        case .monster:
            if form.name.isEmpty { return L.resource("Fill in monster name!") }
            if form.spawnHP <= 0 || form.spawnBalance <= 0 || form.spawnMana <= 0 {
                return L.resource("Fill in all monster values!")
            }
            return nil
        }
    }
}

/// Nested script editor shown over the Spawn dialog. Binds directly to the in-flight
/// `SpawnFormState.dialogScript` so OK/Cancel dismiss the nested sheet and return to
/// the parent Spawn dialog with the in-flight NPC fields intact. The standalone
/// `ScriptDialogView` still drives the canvas-selection edit path, where the script
/// belongs to a record that already lives in the document and routes through
/// `mutate(...)` for undo coverage.
@MainActor private struct SpawnScriptDialogView: View {
    @Bindable var form: SpawnFormState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.resource("Script"))
            TextField("", text: $form.dialogScript, axis: .vertical)
                .lineLimit(5 ... 20)
                .textFieldStyle(.roundedBorder)
            Text(L.resource("Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime."))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(role: .cancel) { dismiss() } label: {
                    Text(L.resource("Cancel"))
                }
                Spacer()
                Button { dismiss() } label: {
                    Text(L.resource("OK"))
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}
