# Omarchy AirPlay

An Omarchy bar widget for controlling Apple TV mirroring through a running Double Take daemon.

## Language

**Bar widget**:
The Omarchy plugin kind that presents an item in the bar and opens a panel.

**Double Take daemon**:
A running Double Take process with its Unix socket control interface available.

**Apple TV**:
An Apple TV identified by the model reported through Double Take. It is MVP1's only supported mirroring target.
_Avoid_: AirPlay device, receiver

**Mirroring**:
The lifecycle through which Double Take sends the Linux desktop to an Apple TV. It includes connecting, waiting for a PIN or password, and streaming.

**Stream**:
A mirroring stream reported by Double Take. It may target an Apple TV or an unsupported device.
_Avoid_: Connection, mirroring session

**Unsupported device**:
A device represented by a Stream that Double Take identifies as something other than an Apple TV.
_Avoid_: Non-Apple receiver

**Available**:
An Apple TV discovered by Double Take that has no Stream.

**Credential**:
A PIN or Password requested during Mirroring. Use PIN or Password when the distinction matters.
_Avoid_: Code

**PIN**:
The visible four-digit pairing credential shown on an Apple TV.

**Password**:
The unrestricted pairing credential configured on an Apple TV and entered through a masked field.
