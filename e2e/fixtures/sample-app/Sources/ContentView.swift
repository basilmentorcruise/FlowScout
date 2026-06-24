import SwiftUI

/// FlowScout fixture content view (E1.8 #29).
///
/// Behavioural contract (plan §2):
///   - A visible Text label so the a11y tree is non-empty (a11yLength > 0).
///   - Exactly one Button with .accessibilityIdentifier("fixture.primaryButton").
///     The button toggles a visible counter so a tap has an observable effect.
///
/// T9: no network calls, no credentials, no real data.
struct ContentView: View {
    @State private var tapCount: Int = 0

    var body: some View {
        VStack(spacing: 24) {
            Text("FlowScout Fixture")
                .font(.title)
                .accessibilityIdentifier("fixture.titleLabel")

            Text(tapCount == 0 ? "Tap the button below" : "Tapped \(tapCount) time(s)")
                .font(.body)
                .accessibilityIdentifier("fixture.statusLabel")

            Button("Tap me") {
                tapCount += 1
            }
            .accessibilityIdentifier("fixture.primaryButton")
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
