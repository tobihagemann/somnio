import Testing
@testable import SomnioUI

struct ChatVerbTests {
    @Test(arguments: [
        ("Hello?", ChatVerb.question),
        ("Are you there?", ChatVerb.question),
        ("Hello!", ChatVerb.exclamation),
        ("Watch out!", ChatVerb.exclamation),
        ("Hello.", ChatVerb.statement),
        ("Hello", ChatVerb.statement),
        ("", ChatVerb.statement)
    ])
    func select(text: String, expected: ChatVerb) {
        #expect(ChatVerb.select(forMessage: text) == expected)
    }
}
