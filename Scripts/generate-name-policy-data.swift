#!/usr/bin/env swift
// Dev-only generator for the pinned Unicode data behind `NamePolicy` (SomnioCore).
//
// Run manually (NOT in CI) whenever the pinned Unicode version is bumped:
//
//     swift Scripts/generate-name-policy-data.swift [inputDir] [outputDir]
//
// With no arguments it downloads the six source files from unicode.org at the pinned
// version into a temp dir and writes the generated Swift into Sources/SomnioCore/Generated.
// Pass `inputDir` to read already-downloaded files from disk instead.
//
// Sources (all read at the SAME pinned version):
//   - confusables.txt        (security/<v>/)   TR39 confusable prototype map
//   - IdentifierStatus.txt   (security/<v>/)   Identifier_Status=Allowed set
//   - IdentifierType.txt     (security/<v>/)   read for provenance; Allowed already folds it in
//   - Scripts.txt            (<v>/ucd/)        primary Script per code point
//   - ScriptExtensions.txt   (<v>/ucd/)        Script_Extensions per code point
//   - PropertyValueAliases.txt (<v>/ucd/)      sc short<->long alias map (unifies the two spellings)
//
// IMPORTANT: bump `NamePolicy.skeletonAlgorithmVersion` whenever you bump `unicodeDataVersion`
// (or otherwise regenerate this data). The stored `name_skeleton_version` is gated on
// `skeletonAlgorithmVersion`, NOT on the data version — a data bump without a version bump
// is a generator bug, because the startup backfill would never recompute stale skeletons.

import Foundation

let unicodeVersion = "15.1.0"

let arguments = CommandLine.arguments
let explicitInputDir = arguments.count > 1 ? arguments[1] : nil
let outputDir = arguments.count > 2 ? arguments[2] : "Sources/SomnioCore/Generated"

// MARK: - Source loading

func loadSources() throws -> [String: String] {
    let securityNames = ["confusables.txt", "IdentifierStatus.txt", "IdentifierType.txt"]
    let ucdNames = ["Scripts.txt", "ScriptExtensions.txt", "PropertyValueAliases.txt"]
    var contents: [String: String] = [:]
    if let inputDir = explicitInputDir {
        for name in securityNames + ucdNames {
            let path = (inputDir as NSString).appendingPathComponent(name)
            contents[name] = try String(contentsOfFile: path, encoding: .utf8)
        }
    } else {
        let securityBase = "https://www.unicode.org/Public/security/\(unicodeVersion)/"
        let ucdBase = "https://www.unicode.org/Public/\(unicodeVersion)/ucd/"
        for name in securityNames {
            contents[name] = try String(contentsOf: URL(string: securityBase + name)!, encoding: .utf8)
        }
        for name in ucdNames {
            contents[name] = try String(contentsOf: URL(string: ucdBase + name)!, encoding: .utf8)
        }
    }
    return contents
}

// MARK: - Line parsing helpers

/// Strips a trailing `# ...` comment and trims whitespace. Returns nil for blank/comment lines.
func dataFields(_ line: String) -> [String]? {
    let withoutComment = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
    let trimmed = withoutComment.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    return trimmed.split(separator: ";", omittingEmptySubsequences: false).map {
        $0.trimmingCharacters(in: .whitespaces)
    }
}

/// Parses `XXXX` or `XXXX..YYYY` into an inclusive `(start, end)` code-point pair.
func parseRange(_ field: String) -> (UInt32, UInt32)? {
    let parts = field.components(separatedBy: "..")
    guard let start = UInt32(parts[0], radix: 16) else { return nil }
    if parts.count == 2, let end = UInt32(parts[1], radix: 16) { return (start, end) }
    return (start, start)
}

func hex(_ value: UInt32) -> String {
    String(value, radix: 16, uppercase: true)
}

// MARK: - Generation

let sources = try loadSources()

// --- Script short<->long alias map (sc property) ---
var shortToLong: [String: String] = [:]
var longNames: Set<String> = []
for line in sources["PropertyValueAliases.txt"]!.split(separator: "\n", omittingEmptySubsequences: false) {
    guard let fields = dataFields(String(line)), fields.count >= 3, fields[0] == "sc" else { continue }
    let short = fields[1]
    let long = fields[2]
    shortToLong[short] = long
    longNames.insert(long)
}

func canonicalScript(_ token: String) -> String {
    if longNames.contains(token) { return token }
    if let long = shortToLong[token] { return long }
    return token
}

/// --- Confusables (drop identity mappings) ---
var confusableEntries: [(UInt32, [UInt32])] = []
for line in sources["confusables.txt"]!.split(separator: "\n", omittingEmptySubsequences: false) {
    guard let fields = dataFields(String(line)), fields.count >= 2 else { continue }
    guard let source = UInt32(fields[0], radix: 16) else { continue }
    let targets = fields[1].split(separator: " ").compactMap { UInt32($0, radix: 16) }
    guard !targets.isEmpty else { continue }
    if targets == [source] { continue }
    confusableEntries.append((source, targets))
}

confusableEntries.sort { $0.0 < $1.0 }

/// --- Primary Script ranges ---
var scriptRanges: [(UInt32, UInt32, String)] = []
for line in sources["Scripts.txt"]!.split(separator: "\n", omittingEmptySubsequences: false) {
    guard let fields = dataFields(String(line)), fields.count >= 2, let range = parseRange(fields[0]) else { continue }
    scriptRanges.append((range.0, range.1, canonicalScript(fields[1])))
    longNames.insert(canonicalScript(fields[1]))
}

scriptRanges.sort { $0.0 < $1.0 }

/// --- Script_Extensions ranges ---
var scriptExtensionRanges: [(UInt32, UInt32, [String])] = []
for line in sources["ScriptExtensions.txt"]!.split(separator: "\n", omittingEmptySubsequences: false) {
    guard let fields = dataFields(String(line)), fields.count >= 2, let range = parseRange(fields[0]) else { continue }
    let scripts = fields[1].split(separator: " ").map { canonicalScript(String($0)) }
    for script in scripts {
        longNames.insert(script)
    }
    scriptExtensionRanges.append((range.0, range.1, scripts))
}

scriptExtensionRanges.sort { $0.0 < $1.0 }

/// --- Identifier_Status=Allowed ranges ---
var allowedRanges: [(UInt32, UInt32)] = []
for line in sources["IdentifierStatus.txt"]!.split(separator: "\n", omittingEmptySubsequences: false) {
    guard let fields = dataFields(String(line)), fields.count >= 2, fields[1] == "Allowed", let range = parseRange(fields[0]) else { continue }
    allowedRanges.append(range)
}

allowedRanges.sort { $0.0 < $1.0 }

// --- Stable script id assignment ---
let sortedScriptNames = longNames.sorted()
var scriptID: [String: Int] = [:]
for (index, name) in sortedScriptNames.enumerated() {
    scriptID[name] = index
}

// MARK: - Emit

let header = """
// Generated by Scripts/generate-name-policy-data.swift -- DO NOT EDIT BY HAND.
// Unicode data version \(unicodeVersion). Regenerate and bump
// NamePolicy.skeletonAlgorithmVersion together on any Unicode bump.

"""

let confusableTable = confusableEntries.map { source, targets in
    "\(hex(source))>\(targets.map(hex).joined(separator: " "))"
}.joined(separator: ";")

let confusablesFile = """
\(header)
enum ConfusablesData {
    /// `source>t1 t2 t3;...` -- TR39 confusable prototype map (identity mappings dropped).
    /// Source is a single scalar; the target is one or more scalars.
    static let mappingTable = "\(confusableTable)"
}
"""

let scriptNamesLine = sortedScriptNames.joined(separator: ";")
let scriptRangesLine = scriptRanges.map { "\(hex($0.0)) \(hex($0.1)) \(scriptID[$0.2]!)" }.joined(separator: ";")
let scriptExtensionsLine = scriptExtensionRanges.map { start, end, scripts in
    "\(hex(start)) \(hex(end)) \(scripts.map { String(scriptID[$0]!) }.joined(separator: ","))"
}.joined(separator: ";")

let scriptFile = """
\(header)
enum ScriptData {
    /// `;`-separated canonical (long) script names; array index is the script id used below.
    static let scriptNames = "\(scriptNamesLine)"

    /// `start end id;...` (hex code points, decimal id) -- primary Script per range.
    static let scriptRanges = "\(scriptRangesLine)"

    /// `start end id,id,...;...` -- Script_Extensions per range (overrides the primary Script).
    static let scriptExtensionRanges = "\(scriptExtensionsLine)"
}
"""

let allowedLine = allowedRanges.map { "\(hex($0.0)) \(hex($0.1))" }.joined(separator: ";")
let identifierFile = """
\(header)
enum IdentifierProfileData {
    /// `start end;...` (hex) -- the Identifier_Status=Allowed set. A code point is Allowed iff its
    /// Identifier_Type is a subset of {Recommended, Inclusion}; IdentifierStatus.txt is that
    /// precomputed result (IdentifierType.txt is read for provenance only).
    static let allowedRanges = "\(allowedLine)"
}
"""

let fileManager = FileManager.default
try fileManager.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
func write(_ contents: String, to name: String) throws {
    let path = (outputDir as NSString).appendingPathComponent(name)
    try (contents + "\n").write(toFile: path, atomically: true, encoding: .utf8)
    print("wrote \(path) (\(contents.utf8.count) bytes)")
}

let versionFile = """
\(header)
enum NamePolicyDataVersion {
    /// The Unicode version this committed data was generated from. `NamePolicy.unicodeDataVersion`
    /// must equal this; a test asserts the two agree so a regeneration that forgets to update
    /// `NamePolicy` (and bump `skeletonAlgorithmVersion`) fails the build.
    static let unicode = "\(unicodeVersion)"
}
"""

try write(confusablesFile, to: "ConfusablesData.swift")
try write(scriptFile, to: "ScriptData.swift")
try write(identifierFile, to: "IdentifierProfileData.swift")
try write(versionFile, to: "NamePolicyDataVersion.swift")

print("confusable entries: \(confusableEntries.count)")
print("script ranges: \(scriptRanges.count), extension ranges: \(scriptExtensionRanges.count), scripts: \(sortedScriptNames.count)")
print("allowed ranges: \(allowedRanges.count)")
