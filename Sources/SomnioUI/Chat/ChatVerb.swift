import Foundation

/// The grammatical verb that frames a spoken chat line, selected from the message
/// itself by inspecting the trailing punctuation.
public enum ChatVerb: Sendable, Equatable, Hashable, CaseIterable {
    case question
    case exclamation
    case statement

    /// Returns the verb that matches the trailing punctuation of `text`: `?` selects
    /// `.question`, `!` selects `.exclamation`, and anything else (including the empty
    /// string) selects `.statement`.
    public static func select(forMessage text: String) -> ChatVerb {
        switch text.last {
        case "?": return .question
        case "!": return .exclamation
        default: return .statement
        }
    }
}
