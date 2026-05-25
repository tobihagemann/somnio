import SomnioCore
import Testing

struct TempoTests {
    @Test(arguments: [
        (Tempo.walk, 60.0),
        (Tempo.default, 120.0),
        (Tempo.run, 240.0)
    ])
    func `pixelsPerSecond matches the legacy tempo speed presets`(tempo: Tempo, expected: Double) {
        #expect(tempo.pixelsPerSecond == expected)
    }
}
