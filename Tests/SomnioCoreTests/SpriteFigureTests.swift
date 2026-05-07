import Foundation
import Testing
@testable import SomnioCore

struct SpriteFigureTests {
    struct Case {
        let characterClass: CharacterClass
        let gender: Gender
        let expected: Int16
    }

    @Test(arguments: [
        Case(characterClass: .fighter, gender: .male, expected: 0),
        Case(characterClass: .fighter, gender: .female, expected: 1),
        Case(characterClass: .lancer, gender: .male, expected: 2),
        Case(characterClass: .lancer, gender: .female, expected: 3),
        Case(characterClass: .warrior, gender: .male, expected: 4),
        Case(characterClass: .warrior, gender: .female, expected: 5),
        Case(characterClass: .thief, gender: .male, expected: 6),
        Case(characterClass: .thief, gender: .female, expected: 7),
        Case(characterClass: .hunter, gender: .male, expected: 8),
        Case(characterClass: .hunter, gender: .female, expected: 9),
        Case(characterClass: .gangster, gender: .male, expected: 10),
        Case(characterClass: .gangster, gender: .female, expected: 11),
        Case(characterClass: .cleric, gender: .male, expected: 12),
        Case(characterClass: .cleric, gender: .female, expected: 13),
        Case(characterClass: .mage, gender: .male, expected: 14),
        Case(characterClass: .mage, gender: .female, expected: 15)
    ])
    func `figure index`(_ testCase: Case) {
        #expect(SpriteFigure.figureIndex(class: testCase.characterClass, gender: testCase.gender) == testCase.expected)
    }
}
