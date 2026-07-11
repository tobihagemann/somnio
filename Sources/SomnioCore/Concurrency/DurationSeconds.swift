public extension Duration {
    /// Fractional seconds, reconstructed from the `(seconds, attoseconds)` components
    /// (1 attosecond = 1e-18 s). The standard library has no Double-seconds accessor; the one
    /// shared definition keeps the subtle conversion from drifting between the server's
    /// movement instrumentation and the client's gameplay tick.
    var seconds: Double {
        Double(components.seconds) + Double(components.attoseconds) * 1e-18
    }
}
