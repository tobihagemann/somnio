import Foundation

public enum Gender: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case male = 0
    case female = 1

    /// The gender display label resolved through the SomnioCore string catalog. Mirrors
    /// `CharacterClass.displayName` so registration sheets resolve both pickers the same way.
    public var displayName: String {
        String(localized: localizationKey, bundle: .module)
    }

    private var localizationKey: String.LocalizationValue {
        switch self {
        case .male: return "Male"
        case .female: return "Female"
        }
    }
}
