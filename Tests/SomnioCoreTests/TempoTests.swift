import SomnioCore
import Testing

struct TempoTests {
    @Test(arguments: [
        (Tempo.walk, 50.0),
        (Tempo.default, 100.0),
        (Tempo.run, 150.0)
    ])
    func `pixelsPerSecond matches the retuned tempo speed presets`(tempo: Tempo, expected: Double) {
        #expect(tempo.pixelsPerSecond == expected)
    }
}
