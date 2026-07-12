import Combine
import Foundation
import SomnioCore
import SwiftUI
import Synchronization
import UniformTypeIdentifiers

/// Sendable serialization payload captured on the main actor by `snapshot(contentType:)`
/// and consumed off-actor by `fileWrapper(snapshot:configuration:)`. Carrying the
/// sector name alongside the body means the background-safe write path never has to
/// read main-actor state.
public struct SectorSnapshot: Sendable, Equatable {
    public let body: SectorBody
    public let sectorName: String

    public init(body: SectorBody, sectorName: String) {
        self.body = body
        self.sectorName = sectorName
    }
}

/// Reference-typed document wrapping a `SectorBody` plus its sector name. The class is
/// `@MainActor`-isolated; the protocol-required file-API methods are `nonisolated` and
/// receive everything they need through the `SectorSnapshot` payload so they remain
/// background-safe. `ObservableObject` (not `@Observable`) because `ReferenceFileDocument`
/// inherits from `ObservableObject` and the macro doesn't synthesize the required
/// `objectWillChange: ObservableObjectPublisher`.
@MainActor public final class SectorDocument: ReferenceFileDocument, ObservableObject {
    public let id: UUID = .init()

    public private(set) var sectorName: String
    public private(set) var body: SectorBody

    /// Lock-guarded mirror of `(body, sectorName)` for the serialization path: AppKit's
    /// save machinery calls `snapshot(contentType:)` on a background queue — autosave-in-
    /// place especially — so it must not assume main-actor isolation (an
    /// `assumeIsolated` there trapped on the first autosave of an edited document). The
    /// main-actor mutation entry points refresh the mirror on every change.
    private let serializationSnapshot: Mutex<SectorSnapshot>

    public var isUninitialized: Bool {
        sectorName.isEmpty && body.dimensions == .zero
    }

    public nonisolated static let readableContentTypes: [UTType] = [.somnioSector]
    public nonisolated static let writableContentTypes: [UTType] = [.somnioSector]

    public nonisolated init() {
        let body = SectorBody(
            version: EditorDefaults.defaultSectorVersion,
            dimensions: .zero,
            floorMaterialID: EditorDefaults.defaultFloorMaterialID,
            light: LightSetting(indoor: false, brightness: 0)
        )
        self.sectorName = ""
        self.body = body
        self.serializationSnapshot = Mutex(SectorSnapshot(body: body, sectorName: ""))
    }

    public nonisolated init(configuration: ReadConfiguration) throws {
        let data = configuration.file.regularFileContents ?? Data()
        let body = try MapCodec.read(data)
        let sectorName = Self.deriveSectorName(from: configuration.file.filename)
        self.body = body
        self.sectorName = sectorName
        self.serializationSnapshot = Mutex(SectorSnapshot(body: body, sectorName: sectorName))
    }

    public nonisolated func snapshot(contentType _: UTType) throws -> SectorSnapshot {
        serializationSnapshot.withLock { $0 }
    }

    public nonisolated func fileWrapper(snapshot: SectorSnapshot, configuration _: WriteConfiguration) throws -> FileWrapper {
        let data = try MapCodec.write(snapshot.body)
        let wrapper = FileWrapper(regularFileWithContents: data)
        wrapper.preferredFilename = snapshot.sectorName.isEmpty ? nil : "\(snapshot.sectorName).somnio-sector"
        return wrapper
    }

    deinit {
        let capturedID = id
        Task { @MainActor in
            SectorWorkspaceRegistry.discard(documentID: capturedID)
        }
    }

    /// Bare-bytes codec helpers shared by the Import/Export commands and the
    /// `SectorDocumentRoundTripTests` round-trip suite. `ReadConfiguration` /
    /// `WriteConfiguration` expose stored properties but no public initializers, so
    /// the file-API methods can't be invoked directly from either context — routing
    /// the codec through these helpers keeps the production Import/Export path and
    /// the test path symmetric.
    public nonisolated static func snapshot(from data: Data) throws -> SectorBody {
        try MapCodec.read(data)
    }

    public nonisolated static func data(for body: SectorBody) throws -> Data {
        try MapCodec.write(body)
    }

    nonisolated static func deriveSectorName(from filename: String?) -> String {
        guard let raw = filename, !raw.isEmpty else { return "" }
        return (raw as NSString).deletingPathExtension
    }

    // MARK: - Internal mutation entry points

    // The Edits extension in `SectorDocument+Edits.swift` is the only public mutation
    // surface. Direct property writes are confined to this file so dirty-tracking
    // (via `UndoManager` registrations on every change) cannot be bypassed.

    func applyMutation(_ change: (inout SectorBody) -> Void) {
        objectWillChange.send()
        change(&body)
        refreshSerializationSnapshot()
    }

    func applySectorName(_ newName: String) {
        objectWillChange.send()
        sectorName = newName
        refreshSerializationSnapshot()
    }

    private func refreshSerializationSnapshot() {
        let snapshot = SectorSnapshot(body: body, sectorName: sectorName)
        serializationSnapshot.withLock { $0 = snapshot }
    }
}
