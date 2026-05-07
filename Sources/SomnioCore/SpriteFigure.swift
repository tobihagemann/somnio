import Foundation

/// Class + gender → sprite-figure index derivation. The index resolves a class-bounded
/// slice of the character sprite pack (8 classes × 2 genders → 16 slots).
public enum SpriteFigure {
    public static func figureIndex(class characterClass: CharacterClass, gender: Gender) -> Int16 {
        Int16(characterClass.rawValue) * 2 + gender.rawValue
    }
}
