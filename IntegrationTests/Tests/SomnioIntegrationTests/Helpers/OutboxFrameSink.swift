import Foundation
import SomnioServerCore

/// Spawns the background drain task that pumps `outbox.stream` into `recorder`. The
/// returned task value is awaited after `outbox.finish()` so the recorder reflects the
/// full buffered frame list before the test body inspects it.
///
/// `FrameRecorder` (defined in `WSGameplayClient.swift`) doubles as the WebSocket-side
/// frame collector for the rest of the suite — keeping one collector type means a future
/// test that drains both a `ConnectionOutbox` and a WS inbound into the same recorder
/// doesn't have to choose between two interchangeable actors.
func startOutboxDrain(outbox: ConnectionOutbox, into recorder: FrameRecorder) -> Task<Void, Never> {
    Task {
        for await frame in outbox.stream {
            await recorder.append(frame)
        }
    }
}
