import Foundation

/// `(positionalIndices, bareCount)` describing the `String(format:)`-style placeholders
/// inside a catalog value. `%N$@` placeholders contribute their index to
/// `positionalIndices`; bare `%@` placeholders (those not part of a positional `%N$@`
/// sequence and not preceded by a `%` escape) contribute to `bareCount`. The same
/// signature on both locales proves the translator did not drop, add, or reorder
/// placeholders. `%%` is treated as a literal percent escape per `String(format:)`
/// semantics and consumes both characters without counting.
public struct PlaceholderSignature: Equatable, Sendable {
    public let positionalIndices: Set<Int>
    public let bareCount: Int

    public init(positionalIndices: Set<Int>, bareCount: Int) {
        self.positionalIndices = positionalIndices
        self.bareCount = bareCount
    }

    /// Parses `value` and returns its placeholder signature, treating `%%` as an
    /// escaped percent rather than a placeholder. Keeping the parser factored here
    /// lets catalog placeholder comparison and direct parser coverage share the same
    /// rules.
    public static func parse(_ value: String) -> PlaceholderSignature {
        var positional: Set<Int> = []
        var bareCount = 0
        let characters = Array(value)
        var index = 0
        while index < characters.count {
            guard characters[index] == "%", index + 1 < characters.count else {
                index += 1
                continue
            }
            if characters[index + 1] == "%" {
                index += 2
                continue
            }
            var cursor = index + 1
            var digits = ""
            while cursor < characters.count, characters[cursor].isNumber {
                digits.append(characters[cursor])
                cursor += 1
            }
            if !digits.isEmpty,
               cursor < characters.count,
               characters[cursor] == "$",
               cursor + 1 < characters.count,
               characters[cursor + 1] == "@",
               let parsed = Int(digits) {
                positional.insert(parsed)
                index = cursor + 2
                continue
            }
            if characters[index + 1] == "@" {
                bareCount += 1
                index += 2
                continue
            }
            index += 1
        }
        return PlaceholderSignature(positionalIndices: positional, bareCount: bareCount)
    }
}
