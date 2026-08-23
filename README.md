# AirPlay for Omarchy

AirPlay is an Omarchy bar widget for controlling one Apple TV through a running [Double Take](https://github.com/omarroth/doubletake) daemon. Open it to find Apple TVs, start mirroring, enter a PIN or password when asked, and disconnect.

## Prerequisites

- Omarchy with its Quickshell-based shell and third-party plugin support.
- Double Take installed, configured, and already running. This widget was built against Double Take commit [`b95fdec`](https://github.com/omarroth/doubletake/commit/b95fdec) and its documented Unix-socket interface.
- An Apple TV with its AirPlay service enabled, reachable from the same network as the Omarchy computer.
- Git, for installation or a local development checkout.
- Node.js, only for running the model tests.

The tested environment on 2026-08-22 was:

- Omarchy `4.0.0-1`
- Quickshell `0.3.0` at revision `28771c7c74b42e20afca0b1b63980cb46515537c`
- `doubletake-git 0.4.0.r28.gb95fdec-1`
- Apple TV model `AppleTV14,1`
- Node.js `25.2.1`

Other versions are untested.

## Ownership boundary

The widget is a client of Double Take. Double Take handles discovery, screen and audio capture, AirPlay, pairing, and saved credentials. See the [Double Take documentation](https://github.com/omarroth/doubletake#readme) for installation and service setup.

The widget does not install, configure, start, stop, restart, or repair Double Take. It does not change capture settings or manage saved pairing credentials. If the daemon is unavailable, the panel reports that state and keeps retrying while open.

## Install

The installer needs a running Omarchy shell. If the shell is stopped, start it with `omarchy restart shell` before installing the widget.

Install the plugin, then place it in the right bar section before Omarchy's monitor widget:

```bash
omarchy plugin add https://github.com/mathiasringhof/omarchy-airplay.git
omarchy plugin enable mathias.airplay --section right --before omarchy.monitor
```

`omarchy plugin add` validates the manifest and rescans plugins. Confirm that Omarchy found it:

```bash
omarchy plugin list
```

The list should contain `mathias.airplay`.

## Use

Click the AirPlay icon on the right side of the bar. The panel opens in `LOADING` and refreshes every three seconds. Double Take discovers Apple TVs continuously, so the widget has no Refresh action.

Apple TVs without a reported stream appear under `AVAILABLE`. Click `+` on the intended Apple TV to connect. Its row shows `CONNECTING` under `AVAILABLE` until Double Take reports a stream. The row then moves under `MIRRORING` and shows `MIRRORING` once active.

Click `×` to disconnect that Apple TV. Closing the panel stops widget polling but never changes the stream.

When Double Take asks for a credential, the waiting stream displays an inline form:

- A PIN is visible and must contain exactly four digits.
- A password is masked and must be non-empty.
- Connect submits the value to that Apple TV. Cancel clears it and disconnects the waiting stream.

The panel also shows unavailable, empty, error, unknown-state, unsupported-device, and multiple-stream conditions. The widget disables controls for unsupported or multiple streams.

## Credential privacy

The widget sends credentials directly to Double Take over its Unix socket. It does not put them in subprocess arguments, logs, settings, persisted plugin files, displayed errors, or reusable retries.

The widget clears reachable field values, queued work, and serialized request strings on submission, cancellation, panel close, socket failure, and plugin reload.

In-memory cleanup is best effort. QML and JavaScript cannot guarantee physical erasure of prior string contents. The widget never owns saved credentials. Double Take stores pairing credentials.

## Local development link

From a checkout that is not already installed at the destination:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
ln -s "$(pwd)" "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/mathias.airplay"
omarchy-shell shell rescanPlugins
omarchy plugin enable mathias.airplay --section right --before omarchy.monitor
```

The symlink keeps the installed plugin pointed at the checkout. Ask the running shell to reload the plugin after editing:

```bash
omarchy-shell shell rescanPlugins
```

Rescan after each edit. If a journal warning still points to coordinates from the old source, run `omarchy restart shell`. This works around [Omarchy rescan bug #6981](https://github.com/basecamp/omarchy/issues/6981). Normal edits do not need a restart.

While exercising the widget, monitor QML and Double Take separately:

```bash
journalctl -f -t omarchy-shell
journalctl -f _COMM=doubletake
```

Never include a real PIN or password in a shell search command, because doing so would expose it through shell history or process arguments.

## Validate

Run all automated checks from the repository root:

```bash
node --test
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell AirPlayIcon.qml Controller.qml Panel.qml
git diff HEAD --check
```

For manual acceptance, enable the linked checkout in the right section and inspect:

- bar and hero icon clarity, native colors and typography, panel sizing, and row alignment
- loading, daemon-unavailable, no-Apple-TV, and available states
- enabled and disabled Connect/Disconnect actions
- visible four-digit PIN and masked password forms, including Connect and Cancel
- unknown and unsupported single streams
- multiple streams with every row read-only

Then test discovery, targeted Connect, `MIRRORING`, and targeted Disconnect on a real Apple TV. If the Apple TV asks for a credential, inspect the journal, process arguments, `~/.config/omarchy/shell.json`, persisted plugin files, and displayed errors for leaks. Never put the credential itself in a search command.

### MVP1 validation record

On 2026-08-22, the linked checkout found a previously paired Apple TV. The icon, available row, targeted Connect, `MIRRORING`, and targeted Disconnect worked. Double Take logged successful pair verification and streaming.

The Apple TV requested no credential, so live leak checks remain open in [issue #8](https://github.com/mathiasringhof/omarchy-airplay/issues/8). Node fixtures cover both credential modes, input rules, targeted requests, cleanup, errors that do not echo daemon data, and retries.

The live run did not force loading, daemon-unavailable, empty, disabled-action, credential-form, unknown-stream, unsupported-stream, or multiple-stream panels. Node fixtures cover their model and action logic, not their visual presentation.

The run exposed a QML warning because available rows lacked the `needsCredential` boolean. Available rows now set it to `false`. Rescans reused cached QML, but the warning disappeared after a full shell restart on 2026-08-23.

## MVP1 exclusions

MVP1 intentionally does not include:

- a dynamic or state-colored bar icon
- mute/unmute or aggregate audio state
- middle-click or right-click shortcuts
- manual IP targets
- Double Take installation, configuration, or service lifecycle management
- user settings or a manual Refresh action
- multiple-stream control or global Disconnect
- custom keyboard cursor/navigation
- plugin-owned saved credentials
- support guarantees beyond the tested versions
- an automated QML/socket integration test

## License

[MIT](LICENSE). The repository's existing license is unchanged.
