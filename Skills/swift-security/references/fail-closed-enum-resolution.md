# Fail-Closed Trust Resolution: Sentinels and Optional Binding

When implementing a fail-closed authorization gate (e.g., "the request is authorized only if trust resolves → otherwise must throw, not silently fall through to the unprotected path"), two related design choices control whether the gate actually closes:

1. **The shape of the resolution enum** — explicit cases vs empty-value sentinels.
2. **The shape of the dispatch branching** — which optional you bind first.

Get either wrong and the gate fails open in a way that compiles cleanly, passes every existing test, and silently downgrades a security decision to the insecure default.

## Principle 1 — Prefer explicit cases over empty-value sentinels

Anti-pattern:

```swift
enum TrustResolution {
    case authorized(trustRoots: [Certificate])
    case operatorDisabled
    case noPinnedRootsConfigured
    case noMatchingRootForLeaf
}

// In the resolver:
guard let trustStore else { return .authorized(trustRoots: []) } // "[]" is a sentinel meaning "throw later"
```

The doc comment promises: "callers throw `trustStoreUnavailable` when roots are empty." That promise is enforced nowhere by the compiler. Every consumer that pattern-matches `.authorized(roots)` and treats `roots` as authoritative (e.g. `if roots.isEmpty { acceptAnyway }` or `if let roots` for nil-coalescing) silently bypasses the gate.

Pattern:

```swift
enum TrustResolution {
    case authorized(trustRoots: [Certificate])
    case operatorDisabled
    case noPinnedRootsConfigured
    case noMatchingRootForLeaf
    case trustStoreUnavailable     // explicit
}

// In the resolver:
guard let trustStore else { return .trustStoreUnavailable }
```

The compiler's exhaustivity check — combined with somnio's project rule that forbids `default:` when switching on project-defined enums (see `.claude/CLAUDE.md`, "Exhaustive switches") — now forces every dispatch site to handle `.trustStoreUnavailable` explicitly. A new case added later breaks the build at every call site rather than silently flowing through a `default:`. Routing logic is in the type, not in a comment.

**Rule:** an enum-resolution outcome that means "you must throw" should be its own case, not an empty associated value of an existing case. This is exactly the leverage somnio's no-`default:` rule is meant to provide — but only if the failure outcome is its own case.

## Principle 2 — Branch on the signal-carrying optional first

Once the resolver returns a clean enum, each dispatch site must consume it without losing information. The trap is at dispatch sites that flatten the enum back into an optional (e.g. `[Certificate]?`) for downstream helpers.

Anti-pattern:

```swift
// In dispatchRequest:
if let trustStore, let trustRoots = context.trustRoots {
    // authorized path
} else {
    // unprotected path — silently runs when trustStore is nil
}
```

When `trustRoots` is non-nil (= "pinning required") but `trustStore` is nil, `if let trustStore, let …` shortcircuits on `trustStore` and falls into the unprotected branch. The `trustRoots != nil` signal is silently discarded.

Pattern:

```swift
// In dispatchRequest:
guard let trustRoots = context.trustRoots else {
    // unprotected path — intentional, .operatorDisabled was set
    try await proceedUnpinned()
    return
}
guard let trustStore else {
    // Unreachable in production: resolveTrust returns .trustStoreUnavailable
    // when the store is nil. Defense in depth.
    throw TrustError.trustStoreUnavailable
}
// authorized path
```

The signal-carrying optional (`trustRoots`) is bound first. The cofactor (`trustStore`) is guarded only on the secure branch, with a typed throw if it's missing. Falling through to the unprotected path is impossible.

**Rule:** when one optional carries a security-relevant signal ("pinning required") and another carries a runtime dependency ("trust-store handle"), branch on the signal first, then guard the dependency on the secure arm. Never combine them into a single `if let A, let B` — the `else` branch becomes a silent downgrade.

## Why this matters at somnio's seams

Somnio does fail-closed validation at its WebSocket wire boundaries: TLS-pin trust-root resolution (`GameplayServerPin`), the `Authorization: Bearer $SOMNIO_ADMIN_TOKEN` admin gate, and host/enum validation that must fail closed (see the host-agreement and unknown-tag seams). Each of these is an authorization decision where the secure outcome and a runtime dependency can be conflated, and where an empty sentinel can stand in for "deny." Both anti-patterns above turn one of those gates into a silent open. Model the deny/unavailable outcome as its own enum case, lean on the no-`default:` rule to force handling, and bind the signal before the dependency.

## Reference Files

- `certificate-trust.md` — SecTrust evaluation, SPKI/CA pinning, trust policies
- `keychain-fundamentals.md` — error-handling discipline for security APIs
- `common-anti-patterns.md` — adjacent anti-patterns (silent error swallowing, default values that bypass checks)
