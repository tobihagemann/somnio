# Handling Soft-Deprecated APIs

*How to behave* when you encounter soft-deprecated SwiftUI APIs. For the list of deprecated-to-modern transitions, see [modern-apis.md](modern-apis.md).

## What "soft-deprecated" means

A soft-deprecated API is marked deprecated in the SDK headers but with a placeholder deprecation version (`100000.0`) that suppresses compiler warnings. It still compiles and works correctly — the marker just signals it shouldn't be used in *new* code. Examples: `NavigationView` (use `NavigationStack` / `NavigationSplitView`), `ActionSheet` / `Alert` (use the `.confirmationDialog` / `.alert` modifiers), `MagnificationGesture` (renamed `MagnifyGesture`), `PresentationMode` (use `\.dismiss`).

Because they still work, treat them as **informational, not urgent**.

## Scope rule — read this first

All soft-deprecation guidance is scoped to the code you are **directly modifying**. If a file has several views and the task touches only one, the others are out of scope.

- Only discuss the view(s) you actually edited.
- Do **not** do drive-by swaps — e.g. don't silently change `NavigationView` to `NavigationStack` while adding an unrelated feature. That produces unexpected diffs, risks regressions (state resets, navigation-behavior changes), and makes the change harder to review.
- Don't flag or offer to migrate soft-deprecated APIs in code you weren't asked to change — including trailing "while I'm here, want me to migrate `OtherView`?" questions.
- Don't proactively scan the codebase for soft-deprecated APIs; only notice them when they appear in code you're already editing.

## By task type

- **Writing new code:** never introduce a new usage of a soft-deprecated API. If unsure whether an API is soft-deprecated, check [modern-apis.md](modern-apis.md) first.
- **Adding a feature / fixing a bug:** if the view you're editing already uses a soft-deprecated API, keep it as-is. After delivering the change, you may add a brief one-line offer to migrate as a *separate* step.
- **Asked to review / refactor / modernize:** point out soft-deprecated APIs in the code under review and suggest the modern replacement, framed as an improvement (not a bug fix).

Migrations are real edits with behavioral risk; they belong in their own focused change, not bundled into unrelated work.
