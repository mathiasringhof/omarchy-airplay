# AirPlay for Omarchy

AirPlay is a personal Omarchy bar widget for discovering Apple TVs and controlling one mirroring stream through an already-running [Double Take](https://github.com/omarroth/doubletake) daemon. It shows Double Take's current state, starts targeted mirroring, collects a PIN or password when the Apple TV asks for one, and disconnects the selected Apple TV.

## Prerequisites

- Omarchy with its Quickshell-based shell and third-party plugin support.
- Double Take installed, configured, and already running. This widget was built against Double Take commit [`b95fdec`](https://github.com/omarroth/doubletake/commit/b95fdec) and its documented Unix-socket interface.
- An Apple TV with its AirPlay service enabled, reachable from the same network as the Omarchy computer.
- Git, for installation or a local development checkout.

The tested environment on 2026-08-22 was:

- Omarchy `4.0.0-1`
- Quickshell `0.3.0` at revision `28771c7c74b42e20afca0b1b63980cb46515537c`
- `doubletake-git 0.4.0.r28.gb95fdec-1`
- Apple TV model `AppleTV14,1`

Compatibility shims for other versions are outside MVP1.

## Ownership boundary

The widget is a client of Double Take. Double Take owns discovery, screen and audio capture, AirPlay protocol behavior, pairing, and saved credentials. Consult the [Double Take documentation](https://github.com/omarroth/doubletake#readme) for its installation, configuration, protocol, and service operation.

The widget does not install, configure, start, stop, restart, or repair Double Take. It does not change capture settings or manage saved pairing credentials. If the daemon is unavailable, the panel reports that state and keeps retrying while open.

## Install

Add the repository, rescan plugins, and place the widget in the right bar section before Omarchy's monitor widget:

```bash
omarchy plugin add https://github.com/mathiasringhof/omarchy-airplay.git --yes
omarchy shell shell rescanPlugins
omarchy plugin enable mathias.airplay --section right --before omarchy.monitor
```

If the shell is not running, start or restart it with `omarchy restart shell`, then repeat the rescan and enable commands. Confirm discovery with:

```bash
omarchy plugin list | rg 'mathias\.airplay'
```

## Use

Select the AirPlay icon on the right side of the bar. The panel opens in `LOADING` and refreshes automatically every three seconds; Double Take discovers Apple TVs continuously, so there is no manual Refresh action.

Apple TVs not currently represented by a stream appear under `AVAILABLE`. Select `+` on the intended Apple TV to connect. The stream moves under `MIRRORING` while it is connecting and shows `MIRRORING` once active. Select `×` to disconnect that Apple TV. Closing the panel stops widget polling but never changes the stream.

When Double Take asks for a credential, the waiting stream displays an inline form:

- A PIN is visible and must contain exactly four digits.
- A password is masked and must be non-empty.
- Connect submits the value to that Apple TV; Cancel clears it and disconnects the waiting stream.

The panel also presents unavailable, empty, error, unknown-state, unsupported-device, and multiple-stream conditions. Unexpected or multiple streams are deliberately read-only where controlling them would exceed the single-Apple-TV safety promise.

## Credential privacy

Credentials are sent directly to Double Take over its Unix socket. The widget does not put them in subprocess arguments, logs, settings, persisted plugin files, displayed errors, or reusable retries. It clears reachable field values, queued work, and serialized request strings on submission, cancellation, panel close, socket failure, and plugin reload.

This cleanup is best-effort: QML and JavaScript cannot guarantee physical erasure of prior string contents from memory. The widget never owns saved credentials; Double Take remains responsible for its pairing credential storage.

## Local development link

From a checkout that is not already installed at the destination:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
ln -s "$(pwd)" "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/mathias.airplay"
omarchy shell shell rescanPlugins
omarchy plugin enable mathias.airplay --section right --before omarchy.monitor
```

The symlink keeps the installed plugin pointed at the checkout, but saved edits are not guaranteed to reload automatically. Rescan after editing:

```bash
omarchy shell shell rescanPlugins
```

Rescanning is the normal workflow. If edited QML remains stale—for example, a journal warning still points to coordinates from the old source—use `omarchy restart shell` to force a fresh load. This fallback tracks [Omarchy rescan bug #6981](https://github.com/basecamp/omarchy/issues/6981); a restart is not otherwise required after every edit.

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

- bar and hero icon clarity, native colors and typography, panel sizing, and row alignment;
- loading, daemon-unavailable, no-Apple-TV, and available states;
- enabled and disabled Connect/Disconnect actions;
- visible four-digit PIN and masked password forms, including Connect and Cancel;
- unknown and unsupported single streams; and
- multiple streams with every row read-only.

Then use a real Apple TV to exercise discovery, targeted Connect, any credential form requested by that Apple TV, `MIRRORING`, and targeted Disconnect. During a credential exercise, confirm the value is absent from the journal, process arguments, `~/.config/omarchy/shell.json`, and persisted plugin files, and that displayed failures use only sanitized messages. Do not search using the credential itself.

### MVP1 validation record

On 2026-08-22, the linked checkout was rescanned and enabled in the right bar section on the tested environment above. A real, previously paired Apple TV was discovered; targeted Connect reached `MIRRORING`, and targeted Disconnect ended the stream. Double Take's journal reported successful pair verification and streaming. The Apple TV did not request a live credential because it was already paired, so no secret was entered during this run. Both PIN and password modes, including input rules, targeted requests, cleanup, sanitized errors, and explicit retry behavior, remain fixture-tested by `node --test`.

Live credential and privacy acceptance is explicitly deferred to [#8, Verify credential handling and privacy on a real Apple TV](https://github.com/mathiasringhof/omarchy-airplay/issues/8). No credential was requested or entered during the MVP1 real-device session, so live non-disclosure could not be assessed. The persisted shell entry contained only the plugin ID; #8 covers verification across journals, process arguments, settings, plugin files, and displayed errors when an Apple TV requests a PIN or password.

The maintainer accepted MVP1 based on the observed real-device icon, available row, targeted Connect, `MIRRORING`, and targeted Disconnect path together with automated fixture coverage for edge states. Loading, daemon-unavailable, empty, disabled-action, credential-form, unknown-stream, unsupported-stream, and multiple-stream presentations were not all manually forced during that session; this acceptance does not claim they were inspected live.

The first exercise also revealed QML warnings because available rows omitted the `needsCredential` boolean used by the credential-form visibility binding. Available rows now provide an explicit `false` default. Repeated warnings during attempted verification were misleading: the shell was still executing stale cached QML because of [Omarchy rescan bug #6981](https://github.com/basecamp/omarchy/issues/6981), not because the minimal fix had failed. A full shell restart at 2026-08-23 08:08 loaded the current checkout; after opening the panel, the warning was absent from the new shell process (PID 983444) logs.

## MVP1 exclusions

MVP1 intentionally does not include:

- a dynamic or state-colored bar icon;
- mute/unmute or aggregate audio state;
- middle-click or right-click shortcuts;
- manual IP targets;
- Double Take installation, configuration, or service lifecycle management;
- user settings or a manual Refresh action;
- multiple-stream control or global Disconnect;
- custom keyboard cursor/navigation;
- plugin-owned saved credentials;
- compatibility shims beyond the tested versions; or
- an automated QML/socket integration harness.

## License

[MIT](LICENSE). The repository's existing license is unchanged.
