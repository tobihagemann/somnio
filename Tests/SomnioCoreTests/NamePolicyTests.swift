import Foundation
import Testing
@testable import SomnioCore

/// Pure value-logic guards for the confusable / script-mixing defense. These run on Linux as well
/// as macOS; the golden vectors below are the cross-platform tripwire for any NFKC/NFD/casing drift
/// between the two toolchains' Foundation, which would otherwise silently desync the two uniqueness
/// layers (`name_normalized` in Postgres vs the Swift-computed `name_skeleton`).
struct NamePolicyTests {
    @Test func `confusable lookalikes share a skeleton`() {
        // Cyrillic А (U+0410) vs Latin A; Greek Ο (U+039F) vs Latin O.
        #expect(NamePolicy.confusableSkeleton("\u{0410}DMIN") == NamePolicy.confusableSkeleton("ADMIN"))
        #expect(NamePolicy.confusableSkeleton("\u{039F}") == NamePolicy.confusableSkeleton("O"))
    }

    @Test func `multi-scalar confusable target is expanded`() {
        // U+0310 COMBINING CANDRABINDU maps to the two-scalar prototype U+0306 U+0307. A scalar-only
        // lookup would drop the second scalar and miss the collision.
        let skeleton = NamePolicy.confusableSkeleton("\u{0310}")
        #expect(Array(skeleton.unicodeScalars.map(\.value)) == [0x0306, 0x0307])
    }

    @Test func `committed golden skeleton vectors`() {
        let vectors: [(String, [UInt32])] = [
            // "m" folds to the "rn" prototype, so ADMIN -> a d r n i n; the Cyrillic spelling folds
            // to the same skeleton, which is the whole point.
            ("ADMIN", [0x61, 0x64, 0x72, 0x6E, 0x69, 0x6E]),
            ("\u{0410}DMIN", [0x61, 0x64, 0x72, 0x6E, 0x69, 0x6E]),
            // ø folds to o + COMBINING LONG SOLIDUS OVERLAY (U+0338).
            ("Bj\u{00F8}rn", [0x62, 0x6A, 0x6F, 0x0338, 0x72, 0x6E]),
            ("\u{FF21}\u{FF22}\u{FF23}", [0x61, 0x62, 0x63]) // fullwidth ABC -> NFKC-folded "abc"
        ]
        for (input, expected) in vectors {
            #expect(Array(NamePolicy.confusableSkeleton(input).unicodeScalars.map(\.value)) == expected)
        }
    }

    @Test func `NFC and NFD spellings produce the same skeleton`() {
        // Precomposed "é" (U+00E9) vs decomposed "e" + combining acute (U+0301): the skeleton must
        // normalize both to one value, or the same name in two encodings would dodge dedup.
        #expect(NamePolicy.confusableSkeleton("Caf\u{00E9}") == NamePolicy.confusableSkeleton("Cafe\u{0301}"))
    }

    @Test func `single-script and tolerated names are accepted`() throws {
        try NamePolicy.validateForRegistration("Bj\u{00F8}rn")
        try NamePolicy.validateForRegistration("ADMIN")
        try NamePolicy.validateForRegistration("Mary Jane")
        try NamePolicy.validateForRegistration("\u{0418}\u{0432}\u{0430}\u{043D}") // pure Cyrillic Иван
    }

    @Test func `mixed Latin and Cyrillic is rejected`() {
        #expect(throws: NamePolicyRejection.mixedScript) {
            try NamePolicy.validateForRegistration("\u{0418}\u{0432}\u{0430}\u{043D}-Ivan")
        }
    }

    @Test func `disallowed characters are rejected`() {
        #expect(throws: NamePolicyRejection.disallowedCharacter) {
            try NamePolicy.validateForRegistration("ab\u{0007}c") // control
        }
        #expect(throws: NamePolicyRejection.disallowedCharacter) {
            try NamePolicy.validateForRegistration("O'Brien") // apostrophe not in the name allowlist
        }
        #expect(throws: NamePolicyRejection.disallowedCharacter) {
            try NamePolicy.validateForRegistration("ab\u{1F600}") // emoji
        }
    }

    @Test func `restricted letter is rejected despite being a letter`() {
        // U+10330 GOTHIC LETTER AHSA is an L* letter but Gothic is an excluded historic script, so it
        // is Identifier_Status=Restricted. Proves the status gate is in force, not a bare L* allowlist
        // (single-script Gothic would otherwise pass the script-mixing check).
        #expect(throws: NamePolicyRejection.disallowedCharacter) {
            try NamePolicy.validateForRegistration("\u{10330}")
        }
    }

    @Test func `leading or trailing separators are rejected`() {
        // A trailing space/hyphen survives the skeleton, so "admin " would dedup separately from
        // "admin"; reject edge separators outright.
        for name in [" admin", "admin ", "admin-", "_admin", "admin_"] {
            #expect(throws: NamePolicyRejection.disallowedCharacter) {
                try NamePolicy.validateForRegistration(name)
            }
        }
    }

    @Test func `names with no visible base character are rejected`() {
        // Empty, and punctuation/space/combining-mark-only names: each lacks a letter or digit.
        for name in ["", "   ", "---", "_-_", "\u{0301}"] {
            #expect(throws: NamePolicyRejection.emptyAfterNormalization) {
                try NamePolicy.validateForRegistration(name)
            }
        }
    }

    @Test func `pinned version constants agree with the generated data`() {
        #expect(NamePolicy.unicodeDataVersion == NamePolicyDataVersion.unicode)
        #expect(NamePolicy.skeletonAlgorithmVersion == 1)
    }
}
