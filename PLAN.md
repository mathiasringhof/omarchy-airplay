# Omarchy AirPlay Widget

## Summary

Create a standalone third-party Omarchy bar plugin at the repository root with ID `omarchy.airplay`. It will use Quickshell’s native Unix-socket API to control the existing Double Take daemon, leaving streaming, capture, credentials storage, and service lifecycle entirely to Double Take.

## Implementation

- Add a `manifest.json` for a single, non-repeatable `bar-widget`, version `0.1.0`, authored by Mathias Ringhof, categorized under Network, defaulting to the right bar section. Expose a configurable refresh interval defaulting to 3 seconds.
- Add a socket-backed controller that:
  - Connects to `$XDG_RUNTIME_DIR/doubletake.sock`, falling back to `/tmp/doubletake.sock` consistently with Double Take.
  - Sends one newline-terminated JSON request per connection and reads one JSON response.
  - Supports `status`, `discover`, `devices`, targeted `connect`, targeted/global `disconnect`, and targeted/global `mute`/`unmute`.
  - Serializes actions, prioritizes them over polling, coalesces duplicate refreshes, enforces a timeout, and refreshes state immediately after mutations.
  - Uses targeted `connect <receiver> <credential>` semantics for every credential submission, so simultaneous prompts are unambiguous.
- Add a pure JavaScript model that normalizes `devices[]` and `streams[]`, merges streams whose receivers have disappeared from discovery, sorts active receivers first, and derives aggregate streaming, credential, and audio state.
- Build an Omarchy-native `Panel`/`KeyboardPanel` UI using shared `qs.Ui`, `qs.Commons`, spacing, colors, borders, tooltips, and keyboard navigation:
  - A reusable QML-drawn AirPlay icon in the bar and panel hero.
  - Active/urgent bar coloring for streaming and credential-required states.
  - Left-click opens the panel, middle-click refreshes discovery, and right-click globally mutes/unmutes active audio streams.
  - Separate “Mirroring” and “Available” receiver sections with name, model, IP, connection state, connect/disconnect controls, and per-receiver mute controls.
  - Inline credential forms on every waiting receiver: visible four-digit validation for on-screen PINs, unrestricted masked input for fixed passwords, plus submit and cancel.
  - Global mute/unmute and disconnect-all actions when applicable.
  - Clear unavailable, empty, connecting, and daemon-error states without attempting to start or configure the service.
- Keep secrets out of subprocess arguments, logs, persisted settings, and error messages; clear credential drafts and serialized requests immediately after submission.
- Add a README covering requirements, interaction behavior, development validation, normal Git installation, and the local development-link workflow. Double Take behavior follows the installed `b95fdec` protocol and its documented distinction between PIN and password prompts ([upstream documentation](https://github.com/omarroth/doubletake/blob/main/README.md)).

## Interfaces

- Plugin entry point: `manifest.json → entryPoints.barWidget → Panel.qml`.
- Controller methods: `refresh()`, `discover()`, `connect(target)`, `submitCredential(target, value)`, `disconnect(target?)`, and `setMuted(target?, muted)`.
- Controller state: daemon availability/state, normalized receivers and streams, pending targets, aggregate audio state, busy state, and last error.
- Daemon request fields remain exactly `cmd`, optional `target`, and optional `pin`; response parsing tolerates omitted optional fields and unknown future states while rejecting malformed JSON safely.

## Test Plan

- Unit-test parsing and derivation against fixtures for:
  - The observed idle `status` response and discovered Apple TV response.
  - Multiple simultaneous streaming/connecting receivers.
  - Concurrent PIN and password prompts.
  - Mixed muted/unmuted and audio/no-audio streams.
  - Missing discovery entries, malformed responses, `ok: false`, and unavailable sockets.
- Run `node --test`, `omarchy plugin validate .`, and `qmllint` with `/usr/share/omarchy/shell` as the import path.
- Query the live daemon read-only with `status`, `devices`, and `discover`; do not initiate mirroring automatically.
- Link the checkout as `~/.config/omarchy/plugins/omarchy.airplay`, rescan plugins, and enable it in the right section before `omarchy.monitor`. If shell IPC is unavailable, leave the link ready and report the exact rescan/enable commands.
- Visually verify panel sizing, theme integration, mouse actions, keyboard navigation, masked password behavior, and idle/unavailable states. Receiver connection, credential, mute, multi-receiver, and disconnect flows remain an explicit manual acceptance test because they start real mirroring.

## Assumptions

- `/usr/share/omarchy/` remains strictly read-only and is used only as the convention reference.
- The widget controls the running daemon but never manages `doubletake.service`, capture configuration, or saved credentials.
- No license is added unless one is chosen separately.
- The development symlink may require an explicit plugin rescan after repository edits because the shell’s file watcher may not observe changes through the link.
