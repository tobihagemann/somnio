import Foundation

public enum CharacterClass: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case fighter = 0
    case lancer = 1
    case warrior = 2
    case thief = 3
    case hunter = 4
    case gangster = 5
    case cleric = 6
    case mage = 7

    /// The class display label resolved through the SomnioCore string catalog. The English
    /// source string doubles as the catalog key per Apple's `String(localized:)` convention;
    /// the German translations carry the original game's authoritative labels.
    public var displayName: String {
        CoreCatalog.localized(localizationKey)
    }

    private var localizationKey: String {
        switch self {
        case .fighter: return "Fighter"
        case .lancer: return "Lancer"
        case .warrior: return "Warrior"
        case .thief: return "Thief"
        case .hunter: return "Hunter"
        case .gangster: return "Gangster"
        case .cleric: return "Cleric"
        case .mage: return "Mage"
        }
    }
}
