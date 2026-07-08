# Instruments Trace Analysis (Somnio)

Use this reference whenever you have an Xcode Instruments `.trace` file --
one you recorded with `scripts/record_trace.py` (see
`references/trace-recording.md`) or one the user handed you. A target
SwiftUI source file is **optional** -- if provided, you can cite specific
lines; without one, the trace still surfaces view names, hot symbols, and
high-severity events that tell you where to look.

The bundled parser reads five lanes for SwiftUI responsiveness (Time
Profiler, Hangs, Animation Hitches, SwiftUI updates, and the SwiftUI
cause graph) and exposes discovery modes (`--list-logs`,
`--list-signposts`, `--fanin-for`) plus a `--window` flag so you can
focus analysis on a precise slice of the trace.

## Preflight: xctrace requires full Xcode

`analyze_trace.py` shells out to `xctrace export`, which ships with the
full **Xcode** install, not the standalone Command Line Tools. Check
before analyzing:

```bash
xcrun -f xctrace && xctrace version
```

If it errors, tell the user to install full Xcode -- the parser cannot
read a `.trace` without `xctrace`.

## What each lane covers (Somnio is not a pure SwiftUI app)

Somnio renders its 3D world with RealityKit over Metal and uses SwiftUI
only for the HUD, in-game overlays, the Esc menu, and the editor chrome.
Keep that split in mind when reading a trace:

- The **SwiftUI updates** and **SwiftUI cause graph** lanes only cover
  the SwiftUI surface (HUD/overlays/editor chrome).
- **Time Profiler**, **Hangs**, **Animation Hitches**, and the
  `main_running_coverage_pct` correlation cover the WHOLE process,
  including the RealityKit/Metal render path.

A calm SwiftUI lane does NOT mean "no problem" -- if frames drop while
that lane is quiet, the cost is in Metal/RealityKit. Read the Time
Profiler hot symbols and the Hitches lane, not the SwiftUI lane.

## When to invoke

Any of these signals:

- Message references a path ending in `.trace`.
- User mentions "hangs", "hitches", "jank", "slow view", "stutter", or a
  frame-rate drop alongside an Instruments recording.
- User asks to focus analysis "after / before / between / during" a log
  message or signpost.

Triggering does **not** require a SwiftUI source file. If one is present
you'll ground recommendations in specific lines; if not, base them on the
view names and symbols the trace reveals.

## The CLI modes

The scripts live alongside this skill at `scripts/` and need only the
Python 3 stdlib + `xctrace` (from full Xcode).

### 1. Full analysis (default)

```bash
python3 "${SKILL_DIR}/scripts/analyze_trace.py" \
  --trace "/path/to/file.trace" \
  --top 10 --top-hitches 5 \
  [--window START_MS:END_MS] \
  --json-only
```

- `--json-only` gives you structured data; omit for JSON + markdown
  summary; `--markdown-only` is for pasting a digest into the chat.
- `--output <path>` writes `<path>.json` and `<path>.md` instead of stdout.
- `--window START_MS:END_MS` (optional) restricts every lane and every
  correlation to that time slice.
- `--run N` selects a specific run when the trace contains more than one
  recording session. Single-run traces don't need it; multi-run traces
  require it and will error with the available run numbers if omitted.
  Use `--list-runs` to dump per-run metadata (template, duration,
  start/end dates, schemas) before analyzing.

### 2. `--list-logs` -- find os_log timestamps

```bash
python3 "${SKILL_DIR}/scripts/analyze_trace.py" --trace <path> --list-logs \
  [--log-subsystem de.tobiha.somnio.app.lifecycle] \
  [--log-category "lifecycle"] \
  [--log-type Fault] \
  [--log-message-contains "loaded sector"] \
  [--log-limit 10] \
  [--window START_MS:END_MS]
```

Returns JSON `{ "logs": [...], "count": N }` where each log entry includes
`time_ms`, `type`, `subsystem`, `category`, `process`, and the formatted
`message` (with args substituted) + raw `format_string`. All filters are
AND-combined; `--log-message-contains` is case-insensitive substring match.
Somnio's logger labels are dot-notated under `de.tobiha.somnio.*`, so the
subsystem is everything up to the last component (the category).

### 3. `--list-signposts` -- find signpost intervals

```bash
python3 "${SKILL_DIR}/scripts/analyze_trace.py" --trace <path> --list-signposts \
  [--signpost-name-contains "SectorLoad"] \
  [--signpost-subsystem de.tobiha.somnio] \
  [--signpost-category "Rendering"] \
  [--window START_MS:END_MS]
```

Returns JSON `{ "intervals": [...], "events": [...] }`. Intervals are
paired `begin`/`end` signposts with `start_ms`, `end_ms`, `duration_ms`,
`name`, `subsystem`, `category`, `process`, `signpost_id`. Single-point
events (and any unpaired begins) go into `events`. All filters are
AND-combined; `--signpost-name-contains` is case-insensitive substring
match.

### 4. `--fanin-for` -- who keeps invalidating this view?

```bash
python3 "${SKILL_DIR}/scripts/analyze_trace.py" --trace <path> \
  --fanin-for "HUDOverlay" \
  [--window START_MS:END_MS] \
  [--top 10]
```

Returns JSON `{ "matches": [...] }`. Each match names a destination node
whose fmt string contains the substring (case-insensitive) and lists its
top incoming source nodes ranked by edge count. Use this after the
`swiftui` lane names an expensive view and you want to know *why it keeps
being invalidated*. A top source of
`closure #1 in UserDefaultObserver.Target.GraphAttribute.send()` is the
canonical signature of an `@AppStorage` / `UserDefaults` feedback storm.

## Composition pattern -- scoping to a slice

When the user says something like "focus on X", "between A and B", or
"during signpost Y", compose the discovery modes:

1. **Discover** -- call `--list-logs` or `--list-signposts` with filters
   that match the user's description. Pick the right entries.
2. **Build the window** -- take `time_ms` (logs) or `start_ms`/`end_ms`
   (intervals) and form `--window START:END`.
3. **Analyse** -- call the default mode with `--window`.

Examples:

- *"Focus on the section after the log saying 'loaded sector'."*
  -> `--list-logs --log-message-contains "loaded sector"`, take the
  entry's `time_ms`, set window = `[that_ms, end_of_trace_ms]` (or use
  the trace `duration_s x 1000`).
- *"Between the 'begin-sync' log and the 'done-sync' log."*
  -> Two `--list-logs` calls (or one with a broader filter), pick the two
  timestamps, set window = `[first, second]`.
- *"During the signpost 'SectorLoad'."*
  -> `--list-signposts --signpost-name-contains "SectorLoad"`, pick the
  interval, set window = `[start_ms, end_ms]`.

## JSON shape

```json
{
  "trace": "...",
  "xctrace_version": "26.4 (...)",
  "template": "SwiftUI",
  "duration_s": 14.83,
  "schemas_available": [...],
  "lanes": [
    { "lane": "time-profiler", "available": true, "schema_used": "time-profile",
      "metrics": { "total_samples": N, "total_weight_ms": ms, "processes": [...] },
      "top_offenders": [ { "symbol", "weight_ms", "percent", "samples", "thread" } ] },
    { "lane": "hangs", "available": true, "schema_used": "potential-hangs",
      "metrics": { "count", "total_duration_ms", "worst_duration_ms",
                   "severity_buckets": {"lt_250ms","250ms_1s","gt_1s"} },
      "top_offenders": [ { "start_ms", "duration_ms", "hang_type", "thread" } ] },
    { "lane": "hitches", "available": true, "schema_used": "hitches",
      "metrics": { "count", "total_hitch_ms", "worst_hitch_ms",
                   "narrative_breakdown": {...}, "system_hitches", "app_hitches" },
      "top_offenders": [ { "start_ms", "hitch_duration_ms", "narrative", "is_system" } ] },
    { "lane": "swiftui", "available": true, "schemas_used": [...],
      "metrics": { "total_events", "unique_views", "total_duration_ms",
                   "severity_breakdown": {"Very Low":N,"Moderate":N,"High":N},
                   "update_type_breakdown": {"View Body Updates":N, ...} },
      "top_offenders": [ { "view", "total_ms", "count", "avg_ms" } ],
      "high_severity_events": [ { "view", "severity", "duration_ms", "category",
                                   "update_type", "description" } ] },
    { "lane": "swiftui-causes", "available": true, "schema_used": "swiftui-causes",
      "metrics": { "total_edges", "unique_sources", "unique_destinations",
                   "top_labels": {...} },
      "top_sources":      [ { "source", "edges", "top_destinations": [...] } ],
      "top_destinations": [ { "destination", "edges", "top_sources":      [...] } ] }
  ],
  "correlations": [
    {
      "trigger": { "lane": "hangs"|"hitches", "start_ms", "end_ms", "duration_ms",
                   "hang_type"|"frame_duration_ms" },
      "time_profiler_main_thread": {
        "samples_in_window": N, "samples_on_main": M,
        "main_running_coverage_pct": 0-100,
        "hot_symbols": [ { "symbol", "samples", "weight_ms", "percent_of_main" } ]
      },
      "swiftui_overlapping_updates": [ { "view", "duration_ms", "start_ms" } ]
    }
  ]
}
```

## Interpretation guide

### `main_running_coverage_pct` is the key diagnostic

Time Profiler samples the main thread every ~1ms. For a correlation window
of `N` ms, you'd expect ~`N` main-thread running samples if main were fully
CPU-bound. Coverage is the ratio of observed main-thread samples to that
expectation.

- **< 25% coverage** -> main thread was **blocked** (I/O, lock, sync XPC,
  `Task.sleep`, waiting on an actor-isolated call). The `hot_symbols` you
  do see are the moments main *was* executing -- look there for the code
  that *initiates* the blocking work, not the work itself. Common fix:
  move to a background executor / `nonisolated` / `Task.detached`.
- **>= 75% coverage** -> main was **CPU-bound** the whole time. `hot_symbols`
  point directly at the expensive work. In Somnio this is where the
  RealityKit/Metal render path or a heavy per-frame update shows up even
  when the SwiftUI lane is quiet. Common fixes: hoist computation out of
  view bodies, cache derived values, avoid per-frame allocation, debounce
  `onChange`, move render-path work off the main actor.
- **25-75%** -> mix. Usually computation plus intermittent I/O; show both
  hot symbols and note that main was partially blocked.

### High-severity SwiftUI events -> reference routing

When `swiftui.high_severity_events[].description` is one of these, route
to Somnio's smell catalog and the deep-dive references:

| description      | Likely cause               | Route to                                                   |
|------------------|----------------------------|------------------------------------------------------------|
| `onChange`       | Expensive `.onChange` body | `references/code-smells.md`                                 |
| `Gesture`        | Heavy gesture handler      | `references/code-smells.md`                                 |
| `Action Callback`| Button/tap handler work    | `references/code-smells.md`                                 |
| `Update`         | View body recomputation    | `references/code-smells.md`, `references/understanding-improving-swiftui-performance.md` |
| `Creation`       | View init cost             | `references/code-smells.md`, `references/demystify-swiftui-performance-wwdc23.md` |
| `Layout`         | GeometryReader churn       | `references/code-smells.md`                                 |

For hang-specific evidence, cross-reference
`references/understanding-hangs-in-your-app.md`; for the Instruments
workflow itself, `references/optimizing-swiftui-performance-instruments.md`.

### Mapping trace findings to source code

If the user gave you a specific file, use it to confirm/cite. If they
didn't, the trace itself tells you which views and symbols to look up.

1. **From `swiftui.top_offenders` and `high_severity_events`**, use the
   `view` string as your search key. Grep the Somnio sources (SwiftUI
   lives in `Sources/SomnioUI/`, the player app in `Sources/SomnioApp/`,
   the editor in `Sources/SomnioEditor/`). A partial match (prefix /
   generic stripping) means it's probably a subview.
2. **From `correlations[].time_profiler_main_thread.hot_symbols`**, treat
   symbols starting with a Somnio module name (`Somnio*`) as candidates.
   System frames (`swift_`, `dyld`, `objc_`, `CA*`, `CF*`, `NS*`,
   `Metal*`, `RealityKit*`, `MTL*`, `__open`, `pthread*`) identify *what*
   the code was doing; the user-code caller one frame up is typically
   what to fix. A hot `Metal*` / `RealityKit*` / `MTL*` stack points at
   the 3D render path (`Sources/SomnioScene3D/`), not the SwiftUI HUD.
3. **From `hitches[].narrative`**, Apple pre-attributes each hitch. The
   string `"Potentially expensive app update(s)"` means SwiftUI blamed
   the app (user code is in scope); absence of narrative usually means it
   was a system hitch or below the threshold.
4. **Correlating hitches with SwiftUI updates**: the
   `swiftui_overlapping_updates` list on each hitch names the views that
   were actively rendering when the frame dropped. Prioritise those --
   but remember an empty list on a real hitch points back at the render
   path, not SwiftUI.

### Cause graph: finding *why* updates keep happening

The `swiftui` lane tells you *what* is expensive; the `swiftui-causes`
lane tells you *why* it keeps being triggered. Each edge is "source node
propagated to destination node" in SwiftUI's attribute graph.

Signatures to watch for in `top_sources`:

- **`closure #1 in UserDefaultObserver.Target.GraphAttribute.send()`** --
  an `@AppStorage` / `UserDefaults` write is fanning out to every reader.
  If the destination list contains multiple `@AppStorage <Type>.<prop>`
  entries with thousands of edges each, you have a feedback storm. Fix by
  reading each key once at a high level and passing values down, or
  wrapping settings in a single `@Observable` so only genuine readers
  invalidate. Route to `references/code-smells.md`.
- **`EnvironmentWriter: ...`** with thousands of edges -- a modifier is
  applied too widely and being re-installed during every layout pass.
  Route to `references/code-smells.md`.
- **`View Creation / Reuse`** as the #1 source -- the hierarchy is
  replacing children rather than mutating in place. Look for ID
  instability (missing/unstable `.id(...)` on ForEach, type-erased
  `AnyView` wrappers, conditional structure swaps). Route to
  `references/code-smells.md`.

When a specific view in `swiftui.high_severity_events` keeps showing up,
run `--fanin-for "<view name>"` to see the ranked list of sources
invalidating it.

### Picking targets from a full-trace analysis

Prioritise from most actionable to least:

1. **Any `hangs` with `main_running_coverage_pct < 25%`** -- blocking-I/O
   smells; nearly always fixable by moving work off-main.
2. **Any `hangs` with `main_running_coverage_pct >= 75%`** -- CPU-bound
   main-thread work; fix the top `hot_symbols` (this is where a heavy
   render-path frame surfaces in Somnio).
3. **`swiftui-causes.top_sources` with > ~1k edges** -- structural
   invalidation bugs (feedback storms, over-applied modifiers). Often
   cheaper to fix than per-view optimisations and collapse many
   downstream high-severity updates at once.
4. **`hitches` with `narrative == "Potentially expensive app update(s)"`**
   and overlapping `swiftui_overlapping_updates` -- specific views to
   restructure.
5. **`swiftui.high_severity_events`** -- `onChange`, `Gesture`, or `Action
   Callback` with `duration_ms > ~16` are frame-dropping handlers. For
   any that keep firing, run `--fanin-for` to find the source.
6. **`swiftui.top_offenders`** -- heaviest views by total body time, even
   without triggering hitches; candidates for view extraction or
   memoisation (`equatable`, `@ViewBuilder` extraction).

## Recommended output format for the user

After running the parser, structure your response as:

1. **One-line summary** -- "Found N hangs, worst Wms; K hitches; J
   high-severity SwiftUI updates."
2. **Root-cause findings** -- per prioritised target (see above), one
   paragraph with the trace evidence (coverage %, hot symbol, overlapping
   view) and a citation from `references/...` for the fix pattern. Name
   the module (SomnioUI vs SomnioScene3D) so the reader knows whether the
   cost is SwiftUI or the render path.
3. **Plan** -- numbered, file-specific edits. Cite line numbers in the
   Somnio source when you know them. Don't edit unless the user asked for
   edits.

Then fold the result into `references/report-template.md` for the final
audit write-up.
