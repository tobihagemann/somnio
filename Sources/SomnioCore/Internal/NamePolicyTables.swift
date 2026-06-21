import Foundation

/// Parses the committed `Generated/*Data.swift` string constants into lookup structures once,
/// on first access. The generated data ships as compact delimited string literals (not
/// dictionary/array literals) specifically to dodge the Swift type-checker blow-up a
/// multi-thousand-entry collection literal would trigger; the parse cost is paid lazily and
/// only on the server, which is the sole consumer of `NamePolicy`.
enum NamePolicyTables {
    /// TR39 confusable prototype map: a source scalar maps to one or more target scalars.
    static let confusables: [UInt32: [Unicode.Scalar]] = {
        var map: [UInt32: [Unicode.Scalar]] = [:]
        for entry in ConfusablesData.mappingTable.split(separator: ";") {
            let halves = entry.split(separator: ">", maxSplits: 1)
            guard halves.count == 2, let source = UInt32(halves[0], radix: 16) else { continue }
            let targets = halves[1].split(separator: " ").compactMap { UInt32($0, radix: 16) }.compactMap(Unicode.Scalar.init)
            guard !targets.isEmpty else { continue }
            map[source] = targets
        }
        return map
    }()

    static let scriptNames: [String] = ScriptData.scriptNames.split(separator: ";").map(String.init)

    static func scriptID(named name: String) -> Int? {
        scriptNames.firstIndex(of: name)
    }

    private static let primaryScript = RangeTable(ScriptData.scriptRanges)
    private static let scriptExtensions = MultiRangeTable(ScriptData.scriptExtensionRanges)
    private static let allowed = BoundsTable(IdentifierProfileData.allowedRanges)

    /// The Script_Extensions set for a scalar, falling back to its primary Script. Empty for an
    /// unassigned scalar (which validation rejects via the Allowed gate first).
    static func scriptSet(for scalar: UInt32) -> Set<Int> {
        if let extensions = scriptExtensions.value(for: scalar) { return Set(extensions) }
        if let primary = primaryScript.value(for: scalar) { return [primary] }
        return []
    }

    static func isAllowed(_ scalar: UInt32) -> Bool {
        allowed.contains(scalar)
    }
}

/// Sorted, non-overlapping `[start, end] -> Int` ranges with a binary-search lookup.
private struct RangeTable {
    private let starts: [UInt32]
    private let ends: [UInt32]
    private let values: [Int]

    init(_ encoded: String) {
        var starts: [UInt32] = [], ends: [UInt32] = [], values: [Int] = []
        for entry in encoded.split(separator: ";") {
            let fields = entry.split(separator: " ")
            guard fields.count == 3,
                  let start = UInt32(fields[0], radix: 16),
                  let end = UInt32(fields[1], radix: 16),
                  let value = Int(fields[2]) else { continue }
            starts.append(start)
            ends.append(end)
            values.append(value)
        }
        self.starts = starts
        self.ends = ends
        self.values = values
    }

    func value(for scalar: UInt32) -> Int? {
        guard let index = indexOfRange(containing: scalar, starts: starts, ends: ends) else { return nil }
        return values[index]
    }
}

/// Like `RangeTable` but each range carries a set of `Int` values (Script_Extensions).
private struct MultiRangeTable {
    private let starts: [UInt32]
    private let ends: [UInt32]
    private let values: [[Int]]

    init(_ encoded: String) {
        var starts: [UInt32] = [], ends: [UInt32] = [], values: [[Int]] = []
        for entry in encoded.split(separator: ";") {
            let fields = entry.split(separator: " ")
            guard fields.count == 3,
                  let start = UInt32(fields[0], radix: 16),
                  let end = UInt32(fields[1], radix: 16) else { continue }
            let ids = fields[2].split(separator: ",").compactMap { Int($0) }
            guard !ids.isEmpty else { continue }
            starts.append(start)
            ends.append(end)
            values.append(ids)
        }
        self.starts = starts
        self.ends = ends
        self.values = values
    }

    func value(for scalar: UInt32) -> [Int]? {
        guard let index = indexOfRange(containing: scalar, starts: starts, ends: ends) else { return nil }
        return values[index]
    }
}

/// Sorted, non-overlapping `[start, end]` ranges with a membership test.
private struct BoundsTable {
    private let starts: [UInt32]
    private let ends: [UInt32]

    init(_ encoded: String) {
        var starts: [UInt32] = [], ends: [UInt32] = []
        for entry in encoded.split(separator: ";") {
            let fields = entry.split(separator: " ")
            guard fields.count == 2,
                  let start = UInt32(fields[0], radix: 16),
                  let end = UInt32(fields[1], radix: 16) else { continue }
            starts.append(start)
            ends.append(end)
        }
        self.starts = starts
        self.ends = ends
    }

    func contains(_ scalar: UInt32) -> Bool {
        indexOfRange(containing: scalar, starts: starts, ends: ends) != nil
    }
}

/// Binary-searches sorted parallel `starts`/`ends` arrays for the range covering `scalar`.
private func indexOfRange(containing scalar: UInt32, starts: [UInt32], ends: [UInt32]) -> Int? {
    var low = 0
    var high = starts.count - 1
    while low <= high {
        let mid = (low + high) / 2
        if scalar < starts[mid] {
            high = mid - 1
        } else if scalar > ends[mid] {
            low = mid + 1
        } else {
            return mid
        }
    }
    return nil
}
