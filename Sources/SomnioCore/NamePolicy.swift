import Foundation

/// Why a name was refused at registration. Kept for diagnostics/logging; the wire surface stays
/// generic so a probing client learns nothing about the exact rule it tripped.
public enum NamePolicyRejection: Error, Sendable, Equatable {
    case disallowedCharacter
    case mixedScript
    case emptyAfterNormalization
}

/// Confusable / script-mixing defense for account and character names, computed entirely in Swift
/// (Postgres `NORMALIZE` cannot fold TR39 confusables, and the Swift stdlib does not expose the
/// Unicode Script property). Two layers, applied to the same value both name surfaces hold:
///
/// 1. `validateForRegistration` -- a TR39-*derived* custom profile (not claimed fully conformant):
///    an Identifier_Status=Allowed gate narrowed to a name shape, plus a Moderately-Restrictive-style
///    script-mixing rejection.
/// 2. `confusableSkeleton` -- a TR39 skeleton stored in `name_skeleton` and deduplicated by a UNIQUE
///    index, so an all-Cyrillic "АDMIN" cannot coexist with an all-Latin "ADMIN".
///
/// Both lean on Foundation NFKC/NFD normalization, which is verified to behave identically on the
/// macOS and Linux toolchains; the committed golden vectors in the test suite guard against drift.
///
/// To bump the pinned Unicode version: re-run `Scripts/generate-name-policy-data.swift`, update
/// `unicodeDataVersion`, and bump `skeletonAlgorithmVersion` (the data bump alone does NOT trigger
/// the startup backfill's recompute -- only a `skeletonAlgorithmVersion` bump does).
///
/// Residual risks, honestly: skeletons are approximate and font-dependent, so a genuinely
/// multilingual name can produce a false positive; and no skeleton catches "vibes" impersonation
/// (`Tobiha` vs `Toblha`) -- only visually-confusable code points, not similar-but-distinct ones.
public enum NamePolicy {
    /// The pinned Unicode version the committed `Generated/*Data.swift` was produced from. This is
    /// documentation only -- it is NOT the value stored in `name_skeleton_version`. Hand-authored
    /// (not aliased to the generated constant) so the version-pin test fails if a regeneration bumps
    /// the data without this being updated -- a prompt to also bump `skeletonAlgorithmVersion`.
    public static let unicodeDataVersion = "15.1.0"

    /// The single monotonic integer written to `name_skeleton_version` and gated on by the startup
    /// backfill (`version < current` recomputes). Bump on ANY change that can alter a computed
    /// skeleton: a `unicodeDataVersion` bump, or a change to the skeleton/normalization/casing logic
    /// below. Bumping the data without bumping this is a generator bug -- the backfill would never
    /// repair the now-stale rows.
    public static let skeletonAlgorithmVersion = 1

    /// The TR39 skeleton of `name`, base-normalized to match `name_normalized` so the two uniqueness
    /// layers agree: NFKC + `lowercased()`, then NFD, then a single confusable-prototype replacement
    /// pass (a source scalar may map to a multi-scalar prototype), then NFD again.
    public static func confusableSkeleton(_ name: String) -> String {
        let base = name.precomposedStringWithCompatibilityMapping.lowercased()
        var mapped = String.UnicodeScalarView()
        for scalar in base.decomposedStringWithCanonicalMapping.unicodeScalars {
            if let prototype = NamePolicyTables.confusables[scalar.value] {
                mapped.append(contentsOf: prototype)
            } else {
                mapped.append(scalar)
            }
        }
        return String(mapped).decomposedStringWithCanonicalMapping
    }

    /// Accepts a name fit for registration or throws the specific reason it was refused. Validates the
    /// NFKC + lowercased form (the same base the skeleton uses) so width/case variants resolve first.
    public static func validateForRegistration(_ name: String) throws(NamePolicyRejection) {
        let scalars = Array(name.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars)
        // Require a visible base character (letter or digit), not merely a non-empty string: a name
        // of only spaces, hyphens, underscores, or combining marks would otherwise pass and yield a
        // blank or parasitic display name usable for impersonation.
        guard scalars.contains(where: isBaseCharacter) else { throw NamePolicyRejection.emptyAfterNormalization }
        // Reject a leading or trailing separator: " admin" / "admin " / "admin-" would otherwise get a
        // distinct skeleton from "admin" (the separator survives the skeleton), so two near-invisible
        // edge-whitespace variants could coexist.
        if let first = scalars.first, let last = scalars.last,
           punctuationAllowlist.contains(first.value) || punctuationAllowlist.contains(last.value) {
            throw NamePolicyRejection.disallowedCharacter
        }
        for scalar in scalars where !isNameShapeAllowed(scalar) {
            throw NamePolicyRejection.disallowedCharacter
        }
        guard scriptsAreCompatible(scalars) else { throw NamePolicyRejection.mixedScript }
    }

    // MARK: - Identifier-status gate

    /// Space, hyphen-minus, low line. The only non-letter/digit characters a name may contain. Kept
    /// explicit rather than admitting every Identifier_Status=Allowed punctuation (which would let in
    /// apostrophe and full stop).
    private static let punctuationAllowlist: Set<UInt32> = [0x20, 0x2D, 0x5F]

    private static func isNameShapeAllowed(_ scalar: Unicode.Scalar) -> Bool {
        if punctuationAllowlist.contains(scalar.value) { return true }
        guard NamePolicyTables.isAllowed(scalar.value) else { return false }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark, .decimalNumber:
            return true
        default:
            return false
        }
    }

    /// A visible base character: a letter or decimal digit. Marks and the allowed punctuation do not
    /// count, so a name must carry at least one of these.
    private static func isBaseCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber:
            return true
        default:
            return false
        }
    }

    // MARK: - Script-mixing gate

    /// The UAX #31 modern scripts recommended for use in identifiers. Pinned explicitly so the
    /// allowed breadth is auditable and tested; `Latin` is intentionally absent here (it is the
    /// always-permitted base of the Latin-plus-one rule below).
    private static let recommendedScriptNames: Set<String> = [
        "Arabic", "Armenian", "Bengali", "Bopomofo", "Cyrillic", "Devanagari", "Ethiopic", "Georgian",
        "Greek", "Gujarati", "Gurmukhi", "Han", "Hangul", "Hebrew", "Hiragana", "Kannada", "Katakana",
        "Khmer", "Lao", "Malayalam", "Myanmar", "Oriya", "Sinhala", "Tamil", "Telugu", "Thaana",
        "Thai", "Tibetan"
    ]

    private struct ScriptPolicy {
        let neutral: Set<Int>
        let latin: Int?
        let cyrillic: Int?
        let greek: Int?
        let recommended: Set<Int>
        let cjkSystems: [Set<Int>]
    }

    private static let scriptPolicy: ScriptPolicy = {
        func id(_ name: String) -> Int? {
            NamePolicyTables.scriptID(named: name)
        }
        func ids(_ names: [String]) -> Set<Int> {
            Set(names.compactMap(id))
        }
        return ScriptPolicy(
            neutral: ids(["Common", "Inherited"]),
            latin: id("Latin"),
            cyrillic: id("Cyrillic"),
            greek: id("Greek"),
            recommended: Set(recommendedScriptNames.compactMap(id)),
            cjkSystems: [
                ids(["Latin", "Han", "Hiragana", "Katakana"]),
                ids(["Latin", "Han", "Bopomofo"]),
                ids(["Latin", "Han", "Hangul"])
            ]
        )
    }()

    /// A Moderately-Restrictive-style check: a name passes if it is single-script, a standard CJK
    /// system (optionally with Latin), or Latin plus exactly one other recommended script that is
    /// neither Cyrillic nor Greek (the highest-risk confusable pair). Common/Inherited scalars
    /// (digits, the allowed punctuation, combining marks) are script-neutral and never constrain.
    private static func scriptsAreCompatible(_ scalars: [Unicode.Scalar]) -> Bool {
        let policy = scriptPolicy
        let perScalar = scalars.compactMap { scalar -> Set<Int>? in
            let scripts = NamePolicyTables.scriptSet(for: scalar.value).subtracting(policy.neutral)
            return scripts.isEmpty ? nil : scripts
        }
        guard let first = perScalar.first else { return true }

        var intersection = first
        var union = first
        for scripts in perScalar.dropFirst() {
            intersection.formIntersection(scripts)
            union.formUnion(scripts)
        }
        if !intersection.isEmpty { return true }

        if policy.cjkSystems.contains(where: { union.isSubset(of: $0) }) { return true }

        if let latin = policy.latin, union.contains(latin) {
            let others = union.subtracting([latin])
            if others.count == 1, let other = others.first,
               policy.recommended.contains(other), other != policy.cyrillic, other != policy.greek {
                return true
            }
        }
        return false
    }
}
