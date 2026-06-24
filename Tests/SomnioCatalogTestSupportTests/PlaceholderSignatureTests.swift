import SomnioCatalogTestSupport
import Testing

struct PlaceholderSignatureTests {
    @Test(arguments: [
        ("Players: %@", PlaceholderSignature(positionalIndices: [], bareCount: 1)),
        ("%1$@ says, \"%2$@\"", PlaceholderSignature(positionalIndices: [1, 2], bareCount: 0)),
        ("%@ greeted %1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 1)),
        ("%99 of users", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("Test %%@ value", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("Literal %% sign", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("%%%@", PlaceholderSignature(positionalIndices: [], bareCount: 1)),
        ("%%%1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 0)),
        ("%@%1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 1)),
        ("%%d works", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("trailing %%", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("trailing %", PlaceholderSignature(positionalIndices: [], bareCount: 0))
    ])
    func `placeholder parser`(input: String, expected: PlaceholderSignature) {
        #expect(PlaceholderSignature.parse(input) == expected)
    }
}
