import Foundation

#if !DEBUG
    // The packaging shell rewrites this file alongside `GameplayServerPin.swift` to
    // populate the operator-provided wss:// endpoint and delete the `#error`
    // directive. The `#error` is the primary safety net guaranteeing no release
    // ships without a hardcoded production URL.
    #error("Replace gameplayProductionURL in GameplayServerURL.swift with the operator-provided wss:// endpoint before shipping a release build, alongside the matching gameplayProductionTrustRootPEM in GameplayServerPin.swift.")
    let gameplayProductionURL: String = ""
#endif
