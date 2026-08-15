import Testing
@testable import SomnioEditor

/// The rest of the draft lifecycle is SwiftUI-bound — when `onChange` fires, whether focus has
/// settled by then — and is not reachable from here.
struct InspectorDraftTests {
    @Test func `an unfocused draft always follows the document`() {
        #expect(InspectorDraft.reseeded(draft: "300", isFocused: false, from: Int16(256), to: 300) == "300")
    }

    @Test func `an unfocused draft that already matches still follows the document`() {
        #expect(InspectorDraft.reseeded(draft: "256", isFocused: false, from: Int16(256), to: 300) == "300")
    }

    @Test func `an untouched focused draft follows the document`() {
        #expect(InspectorDraft.reseeded(draft: "256", isFocused: true, from: Int16(256), to: 300) == "300")
    }

    @Test func `a focused draft the user has typed into survives`() {
        #expect(InspectorDraft.reseeded(draft: "30", isFocused: true, from: Int16(256), to: 300) == nil)
    }

    /// The arriving value never equals the draft mid-change, so keying on it would reseed nothing
    /// while focused.
    @Test func `the untouched test compares the departing value, not the arriving one`() {
        #expect(InspectorDraft.reseeded(draft: "300", isFocused: true, from: Int16(256), to: 300) == nil)
    }

    /// A non-integer field is seeded from the value's rendering, so the untouched test has to
    /// render too rather than compare raw text.
    @Test func `a draft matching the committed value's rendering counts as untouched`() {
        #expect(InspectorDraft.reseeded(draft: "270.0", isFocused: true, from: Float(270), to: 90) == "90.0")
        #expect(InspectorDraft.reseeded(draft: "270", isFocused: true, from: Float(270), to: 90) == nil)
    }

    /// `InspectorScriptField` instantiates the same helper with `String`, where the rendering is
    /// the identity.
    @Test func `a string-valued field compares its text directly`() {
        #expect(InspectorDraft.reseeded(draft: "Hallo", isFocused: true, from: "Hallo", to: "Servus") == "Servus")
        #expect(InspectorDraft.reseeded(draft: "Hall", isFocused: true, from: "Hallo", to: "Servus") == nil)
    }
}
