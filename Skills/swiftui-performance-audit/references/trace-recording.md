# Recording an Instruments Trace (Somnio)

Use this reference when you can run the app and want to capture a fresh
Instruments trace yourself instead of asking the user to record one and
paste screenshots. Somnio profiles on the **host Mac** (a native macOS
app: RealityKit 3D world over Metal + a SwiftUI HUD/overlays + a
document-based editor), so every recipe here targets the local Mac, not
an iOS device or the Simulator.

The bundled `scripts/record_trace.py` wraps `xctrace record` with:

- The **SwiftUI** template by default (override with `--template`).
- **Manual stop** via Ctrl+C, a stop-file, or `--time-limit`.
- JSON discovery for devices and templates.
- Normal Python exit codes so an agent can orchestrate.

The scripts are Python 3 stdlib only (no pip installs). They just need
`xctrace` on PATH.

## Preflight: xctrace requires full Xcode

`xctrace` ships with the full **Xcode** install, NOT the standalone
Command Line Tools. If only the CLT are present, every recipe here fails.
Check first and surface a clear message:

```bash
xcrun -f xctrace          # prints the path if available
xctrace version           # prints the version banner
```

If either errors (`xcrun: error: unable to find utility "xctrace"`),
tell the user: **Install the full Xcode (not just Command Line Tools) to
record or analyze Instruments traces.** Everything downstream
(`analyze_trace.py` included) depends on `xctrace`.

## Build to profile

`xctrace` targets a **PID, a process name, or a `.app` bundle path** --
there is NO Xcode project or scheme involved (Somnio is SwiftPM-only).
That means you can profile any of:

- A packaged bundle from `Scripts/package_app.sh [debug|release] player`
  (or `editor`) -- `--launch <path to Somnio.app>`.
- A bare `swift run SomnioApp` (or `SomnioEditor`) -- `--attach Somnio`
  by process name, or `--attach <pid>`.

**Build configuration:** meaningful absolute numbers (symbol costs,
hitch severity) want a Release-ish build, so prefer a
`Scripts/package_app.sh release player` bundle when you care about real
magnitudes. A debug `.app`, or attaching to `swift run SomnioApp`, is
perfectly fine for **relative before/after** comparisons of a change --
just keep the build configuration identical across the two captures.

## Typical flows (host Mac)

### A) Launch the packaged app and record from the first frame

```bash
python3 "${SKILL_DIR}/scripts/record_trace.py" \
  --launch "/path/to/Somnio.app" \
  --output ~/Desktop/somnio-launch.trace
```

`--device` defaults to the host Mac, so it can be omitted. This is the
recipe for cold-start hitches and view-creation cost, and it captures the
whole process from launch -- including the RealityKit/Metal render path
coming up.

### B) Attach to an already-running app

```bash
# By process name -- works for a packaged .app or `swift run SomnioApp`.
python3 "${SKILL_DIR}/scripts/record_trace.py" \
  --attach Somnio \
  --output ~/Desktop/somnio-session.trace

# Or by PID.
python3 "${SKILL_DIR}/scripts/record_trace.py" \
  --attach 54321 \
  --output ~/Desktop/somnio-session.trace
```

Leave it running while you (or the user) exercise the app -- walk the
character around, open the Esc menu, scroll-zoom, drive the editor. Stop
with **Ctrl+C**.

### C) Agent-driven: start in background, stop via stop-file

When you are running non-interactively -- e.g. via `Bash run_in_background`
-- use a stop-file so you can signal the recording to end cleanly:

```bash
# Start recording (background)
python3 "${SKILL_DIR}/scripts/record_trace.py" \
  --attach Somnio --stop-file /tmp/stop-trace \
  --output ~/Desktop/somnio-session.trace

# ...exercise the app...

# Stop cleanly (from another shell or tool call)
touch /tmp/stop-trace
```

The script polls every 0.5s for the stop-file, sends SIGINT to xctrace
when it appears, and waits up to 60s for the trace to finalise.

### D) Time-boxed recording

```bash
python3 "${SKILL_DIR}/scripts/record_trace.py" \
  --attach Somnio --time-limit 30s --output ~/Desktop/30s.trace
```

xctrace stops itself at the limit.

## Discovery helpers

```bash
# List every connected device, simulator, and the host -- JSON.
python3 "${SKILL_DIR}/scripts/record_trace.py" --list-devices

# List all Instruments templates -- JSON with a flat list + by-section map.
python3 "${SKILL_DIR}/scripts/record_trace.py" --list-templates
```

Device entries have `kind` (`devices`, `devices offline`, `simulators`),
`name`, `os`, `udid`. For Somnio the target is the host Mac, which shows
up under `devices` -- that is the default when `--device` is omitted.

## Picking a template

For Somnio the host Mac supports the default **SwiftUI** template, which
populates all five lanes. The Simulator restriction from the upstream
skill does not apply here -- we always profile the host Mac.

| Target                                        | Template to pass    |
|-----------------------------------------------|---------------------|
| Host Mac (Somnio player or editor)            | `SwiftUI` (default) |
| Ad-hoc hang hunting only                      | `Time Profiler`     |
| Ad-hoc frame-drop hunting only                | `Animation Hitches` |

## What each lane actually covers (important for Somnio)

Somnio is NOT a pure SwiftUI app -- most of the pixels come from
RealityKit/Metal, with SwiftUI only for the HUD, in-game overlays, the
Esc menu, and the editor chrome. That split matters when reading a trace:

- The **SwiftUI updates** lane and the **SwiftUI cause graph** lane only
  illuminate the **SwiftUI surface** (HUD/overlays/editor chrome). They
  say nothing about the 3D render path.
- **Time Profiler**, **Hangs**, **Animation Hitches**, and the
  cross-lane `main_running_coverage_pct` correlation cover the **WHOLE
  process, including the RealityKit/Metal render path**.

So an empty-ish or quiet SwiftUI lane does **NOT** mean "no problem." If
frames are dropping while the SwiftUI lane is calm, the cost is almost
certainly in Metal/RealityKit -- look at Time Profiler hot symbols and
the Animation Hitches lane, not the SwiftUI lane.

## Chaining into analysis

The recording script prints `trace written: <path>` on exit. Feed that
path straight into `analyze_trace.py`:

```bash
TRACE=$(python3 "${SKILL_DIR}/scripts/record_trace.py" \
    --attach Somnio --stop-file /tmp/stop-trace --output ~/Desktop/session.trace \
    2>&1 | awk '/trace written:/ {print $NF}')
python3 "${SKILL_DIR}/scripts/analyze_trace.py" --trace "$TRACE" --json-only
```

If you want a specific scope, combine with `--list-logs` /
`--list-signposts` / `--window` from `references/trace-analysis.md`.
Somnio logs under `de.tobiha.somnio.*` subsystems, which are handy
`--log-subsystem` filters when hunting a specific slice.

## Failure modes to handle

- **xctrace missing** -- only Command Line Tools installed. Run the
  preflight above and tell the user to install full Xcode.
- **Output path exists** -- the script refuses to overwrite. Either pick
  a new `--output` or delete the existing bundle.
- **App not running (for `--attach`)** -- xctrace exits with an error;
  fall back to `--launch <Somnio.app>` or tell the user to open the app
  first.
- **Stale binary** -- if you repackaged the `.app` but the old one is
  still running, `--attach` grabs the stale process. Relaunch before
  attaching.
