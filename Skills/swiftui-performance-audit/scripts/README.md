# Instruments trace tooling

These scripts (`record_trace.py`, `analyze_trace.py`, and the
`instruments_parser/` package) are imported verbatim from the upstream
skill **AvdLee/SwiftUI-Agent-Skill** (subdirectory `swiftui-expert-skill`).

- Source: https://github.com/AvdLee/SwiftUI-Agent-Skill
- License: MIT
- Copyright (c) 2026 Antoine van der Lee

They are unmodified. Python 3 standard library only (no pip installs);
they require `xctrace`, which ships with the full Xcode install (not the
standalone Command Line Tools). See `../references/trace-recording.md`
and `../references/trace-analysis.md` for the Somnio-specific usage.
