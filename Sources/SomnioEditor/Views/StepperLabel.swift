import SwiftUI

/// Shared "<localized name>: <value>" label for the overlay form `Stepper`s.
@MainActor struct StepperLabel: View {
    let title: LocalizedStringResource
    let value: Int16

    var body: some View {
        Text("\(String(localized: title)): \(value)")
    }
}
