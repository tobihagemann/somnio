import SomnioCLICore

/// `@main` shim. Cannot live in a file literally named `main.swift` (SwiftPM treats those
/// as top-level entry points and `@main` is forbidden), and `await SomnioCLITool.main()`
/// at the top level resolves to the synchronous `ParsableCommand.main()` overload — the
/// async dispatch needs an explicit async context, which this static `main()` provides.
@available(macOS 10.15, macCatalyst 13, iOS 13, tvOS 13, watchOS 6, *)
@main
enum SomnioCLIEntry {
    static func main() async {
        await SomnioCLITool.main()
    }
}
