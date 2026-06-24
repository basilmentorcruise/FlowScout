import SwiftUI

/// FlowScout sample-app fixture entry point (E1.8 #29).
/// A minimal single-screen SwiftUI app used as the default E2E fixture
/// when no owner-supplied .app is provided.
///
/// T9 hygiene: no network calls, no credentials, no real data.
@main
struct SampleApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
