import SomnioTheme
import SwiftUI

/// Floating tool palette (top-leading): one icon button per `EditorTool`, the active tool
/// outlined in the selection yellow. Selection is the Select tool, placement is the kind's
/// own tool.
@MainActor struct ToolPaletteView: View {
    @Bindable var workspace: SectorWorkspace

    var body: some View {
        FantasyPanel(fillOpacity: 0.6) {
            VStack(spacing: 8) {
                ForEach(EditorTool.allCases) { tool in
                    toolButton(tool)
                }
            }
        }
    }

    private func toolButton(_ tool: EditorTool) -> some View {
        Button {
            workspace.tool = tool
        } label: {
            Image(systemName: Self.icon(for: tool))
                .frame(width: 24, height: 24)
        }
        .buttonStyle(FantasyButtonStyle(compact: true))
        .overlay {
            if workspace.tool == tool {
                Rectangle().stroke(.yellow, lineWidth: 2)
            }
        }
        .help(Text(Self.title(for: tool)))
        // Icon-only buttons are invisible to VoiceOver/Voice Control without a label,
        // and the yellow outline alone doesn't announce the active tool.
        .accessibilityLabel(Text(Self.title(for: tool)))
        .accessibilityAddTraits(workspace.tool == tool ? .isSelected : [])
    }

    static func title(for tool: EditorTool) -> LocalizedStringResource {
        switch tool {
        case .select: return L.resource("Select")
        case .object: return L.resource("Object")
        case .mask: return L.resource("Mask")
        case .portal: return L.resource("Sector portal")
        case .npc: return L.resource("NPC")
        case .monster: return L.resource("Monster")
        }
    }

    private static func icon(for tool: EditorTool) -> String {
        switch tool {
        case .select: return "cursorarrow"
        case .object: return "cube"
        case .mask: return "square.dashed"
        case .portal: return "door.left.hand.open"
        case .npc: return "person"
        case .monster: return "pawprint"
        }
    }
}
