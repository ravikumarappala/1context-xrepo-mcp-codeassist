# iOS / Swift expert pack (example)

## Architecture
- SwiftUI + MVVM + Repository. ViewModels are @MainActor.
- Shared features ship as Swift packages, pinned by version.

## Do / don't
- Do: async/await, small views, previews for new views.
- Don't: put API keys in the app, or call AI providers directly from the app.

## Checks
- Build for the simulator and run unit tests before finishing.
