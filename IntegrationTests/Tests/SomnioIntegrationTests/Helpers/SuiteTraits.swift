import Testing

extension Trait where Self == Testing.ConditionTrait {
    /// Suites carrying this trait skip cleanly when neither Docker nor Podman is reachable
    /// on the runner. Centralizes the `.enabled(if:)` literal so a future change (e.g.,
    /// adding an env-var override) lands in one place.
    static var requiresContainerRuntime: Self {
        .enabled(if: ContainerRuntime.detected != nil)
    }
}
