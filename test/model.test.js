const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const context = vm.createContext({ JSON, String, Array, Object, Error })
const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
vm.runInContext(source, context, { filename: "Model.js" })

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name + ".json"), "utf8"))
}

function derive(name) {
  const data = fixture(name)
  return context.derive(
    context.parseResponse(JSON.stringify(data.status), "status"),
    context.parseResponse(JSON.stringify(data.devices), "devices")
  )
}

test("opening state is loading", () => {
  const expected = fixture("loading")
  const model = context.loadingModel()
  assert.equal(model.heroStatus, expected.heroStatus)
  assert.equal(model.loading, expected.loading)
})

test("socket failure is daemon unavailable", () => {
  const expected = fixture("unavailable")
  const model = context.unavailableModel(expected.error)
  assert.equal(model.heroStatus, expected.heroStatus)
  assert.equal(model.daemonAvailable, expected.daemonAvailable)
  assert.equal(model.error, expected.error)
})

test("idle daemon with no Apple TVs is empty", () => {
  const model = derive("idle")
  assert.equal(model.heroStatus, "NO APPLE TVS")
  assert.deepEqual(Array.from(model.mirroring), [])
  assert.deepEqual(Array.from(model.available), [])
})

test("available rows contain only Apple TVs and sort by name then IP", () => {
  const model = derive("available")
  assert.equal(model.heroStatus, "AVAILABLE")
  assert.deepEqual(Array.from(model.available, row => row.name), ["Bedroom", "Living Room"])
  assert.equal(model.available[0].model, "AppleTV11,1")
  assert.equal(model.available[0].ip, "10.0.0.10")
  for (const row of model.available) {
    assert.equal(typeof row.needsCredential, "boolean")
    assert.equal(row.needsCredential, false)
    assert.equal(row.credentialKind, "")
  }
})

test("one ordinary stream moves its Apple TV to mirroring", () => {
  const model = derive("streaming")
  assert.equal(model.heroStatus, "MIRRORING")
  assert.equal(model.mirroring.length, 1)
  assert.equal(model.mirroring[0].stateLabel, "MIRRORING")
  assert.deepEqual(Array.from(model.available, row => row.name), ["Bedroom"])
})

test("connecting and credential requirements use explicit stream labels", () => {
  assert.equal(context.streamLabel("connecting"), "CONNECTING")
  assert.equal(context.streamLabel("pin_required", "pin"), "PIN REQUIRED")
  assert.equal(context.streamLabel("pin_required", "password"), "PASSWORD REQUIRED")
  assert.equal(context.streamLabel("pin_required"), "UNKNOWN STATE")
  assert.equal(context.streamLabel("future_state"), "UNKNOWN STATE")
})

test("credential forms distinguish visible four-digit PINs from masked passwords", () => {
  assert.equal(context.credentialKind({ state: "pin_required", credential_kind: "pin" }), "pin")
  assert.equal(context.credentialKind({ state: "pin_required", credential_kind: "password" }), "password")
  assert.equal(context.credentialKind({ state: "pin_required" }), "")
  assert.equal(context.credentialKind({ state: "pin_required", credential_kind: "future" }), "")
  assert.equal(context.credentialKind({ state: "streaming", credential_kind: "password" }), "")

  assert.equal(context.credentialValid("pin", "1234"), true)
  assert.equal(context.credentialValid("pin", "123"), false)
  assert.equal(context.credentialValid("pin", "12a4"), false)
  assert.equal(context.credentialValid("password", "correct horse battery staple"), true)
  assert.equal(context.credentialValid("password", ""), false)
})

test("credential submission uses targeted connect and the exact pin field", () => {
  const request = context.credentialRequest("10.0.0.20", "1234")
  assert.deepEqual(Object.keys(request).sort(), ["cmd", "pin", "target"])
  assert.equal(request.cmd, "connect")
  assert.equal(request.target, "10.0.0.20")
  assert.equal(request.pin, "1234")
  assert.equal(context.responseIsRejection('{"ok":false,"state":"pin_required","error":"no"}'), true)
  assert.equal(context.responseIsRejection('{"ok":true,"state":"connecting"}'), false)
  assert.equal(context.responseIsRejection("malformed"), false)
})

test("one waiting stream exposes the PIN or Password hero and remains targeted", () => {
  const devices = fixture("available").devices
  const pin = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Bedroom", device_ip: "10.0.0.10", state: "pin_required", credential_kind: "pin" }]
  }, devices)
  const password = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "pin_required", credential_kind: "password" }]
  }, devices)

  assert.equal(pin.heroStatus, "PIN REQUIRED")
  assert.equal(pin.mirroring[0].stateLabel, "PIN REQUIRED")
  assert.equal(pin.mirroring[0].credentialKind, "pin")
  assert.equal(pin.mirroring[0].needsCredential, true)
  assert.equal(password.heroStatus, "PASSWORD REQUIRED")
  assert.equal(password.mirroring[0].stateLabel, "PASSWORD REQUIRED")
  assert.equal(password.mirroring[0].credentialKind, "password")
  assert.equal(password.mirroring[0].needsCredential, true)
})

test("cancel is targeted and secret cleanup returns unreachable draft, buffer, and queued state", () => {
  const devices = fixture("available").devices
  const waiting = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "pin_required", credential_kind: "pin" }]
  }, devices)
  assert.deepEqual(
    Object.assign({}, context.credentialCancelRequest(waiting, "10.0.0.20")),
    { cmd: "disconnect", target: "10.0.0.20" }
  )

  const credentialWork = {
    action: "credential",
    payload: context.credentialRequest("10.0.0.20", "1234")
  }
  const cleared = context.clearCredentialState({
    draft: "1234",
    credentialEpoch: 7,
    serializedRequest: JSON.stringify(credentialWork.payload),
    queuedWork: credentialWork
  })
  assert.equal(cleared.draft, "")
  assert.equal(cleared.credentialEpoch, 8)
  assert.equal(cleared.serializedRequest, "")
  assert.equal(cleared.queuedWork, null)
})

test("credential rejection remains on the waiting form until a fresh explicit targeted retry", () => {
  const devices = fixture("available").devices
  const waiting = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "pin_required", credential_kind: "pin" }]
  }, devices)
  const rejected = context.newCredentialRejection("10.0.0.20", "pin")
  const retained = context.credentialRejectionAfterRefresh(rejected, waiting)
  assert.equal(retained.message, "The PIN was rejected. Enter a fresh PIN and select Connect.")
  assert.equal(
    context.newCredentialRejection("10.0.0.20", "password").message,
    "The Password was rejected. Enter a fresh Password and select Connect."
  )

  const retry = context.credentialRequest(retained.target, "5678")
  assert.deepEqual(Object.assign({}, retry), {
    cmd: "connect",
    target: "10.0.0.20",
    pin: "5678"
  })
  const connecting = context.applyPending(waiting, "credential", retained.target)
  assert.equal(context.credentialRejectionAfterRefresh(retained, connecting), null)
})

test("unknown prompts and every action in a multiple-stream model are read-only", () => {
  const devices = fixture("available").devices
  const unknown = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "pin_required" }]
  }, devices)
  assert.equal(unknown.mirroring[0].stateLabel, "UNKNOWN STATE")
  assert.equal(unknown.mirroring[0].needsCredential, false)
  assert.equal(context.canDisconnect(unknown, "10.0.0.20"), false)

  const multiple = context.derive({
    ok: true,
    state: "pin_required",
    streams: [
      { device: "Bedroom", device_ip: "10.0.0.10", state: "pin_required", credential_kind: "pin" },
      { device: "Living Room", device_ip: "10.0.0.20", state: "pin_required", credential_kind: "password" }
    ]
  }, devices)
  assert.equal(multiple.heroStatus, "MULTIPLE STREAMS")
  assert.equal(context.canSubmitCredential(multiple, "10.0.0.10", "pin", "1234"), false)
  assert.equal(context.canCancelCredential(multiple, "10.0.0.10"), false)
  assert.equal(context.canDisconnect(multiple, "10.0.0.10"), false)
  assert.equal(context.credentialCancelRequest(multiple, "10.0.0.10"), null)

  const missingDiscovery = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{ device: "Unknown", device_ip: "10.0.0.99", state: "pin_required", credential_kind: "pin" }]
  }, devices)
  assert.equal(missingDiscovery.mirroring[0].needsCredential, false)
  assert.equal(context.canSubmitCredential(missingDiscovery, "10.0.0.99", "pin", "1234"), false)
  assert.equal(context.canCancelCredential(missingDiscovery, "10.0.0.99"), false)
})

test("connect is enabled only for a discovered available Apple TV when no stream exists", () => {
  const available = derive("available")
  assert.equal(context.canConnect(available, "10.0.0.10"), true)
  assert.equal(context.canConnect(available, "10.0.0.99"), false)

  const streaming = derive("streaming")
  assert.equal(context.canConnect(streaming, "10.0.0.10"), false)
  assert.equal(streaming.available[0].canConnect, false)
})

test("connect and disconnect requests retain the selected Apple TV target", () => {
  const connect = context.targetedRequest("connect", "10.0.0.20")
  const disconnect = context.targetedRequest("disconnect", "10.0.0.20")
  assert.equal(connect.cmd, "connect")
  assert.equal(connect.target, "10.0.0.20")
  assert.equal(disconnect.cmd, "disconnect")
  assert.equal(disconnect.target, "10.0.0.20")
})

test("pending connect moves only its discovered row to connecting without claiming a stream", () => {
  const data = fixture("available")
  const model = context.derive(data.status, data.devices, "connect", "10.0.0.20")
  assert.equal(model.heroStatus, "CONNECTING")
  assert.equal(model.mirroring.length, 0)
  const target = model.available.find(row => row.ip === "10.0.0.20")
  assert.equal(target.state, "connecting")
  assert.equal(target.stateLabel, "CONNECTING")
  assert.equal(target.pending, true)
  assert.equal(target.actionKind, "connect")
  assert.equal(target.canConnect, false)
  assert.equal(model.available.every(row => !row.canConnect), true)
})

test("polling observes connecting and then mirroring from daemon streams", () => {
  const devices = fixture("available").devices
  const connecting = context.derive({
    ok: true,
    state: "connecting",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "connecting" }]
  }, devices)
  assert.equal(connecting.heroStatus, "CONNECTING")
  assert.equal(connecting.mirroring[0].pending, false)
  assert.equal(connecting.mirroring[0].stateLabel, "CONNECTING")

  const streaming = derive("streaming")
  assert.equal(streaming.heroStatus, "MIRRORING")
  assert.equal(streaming.mirroring[0].stateLabel, "MIRRORING")

  const failed = context.derive({
    ok: true,
    state: "error",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "error" }]
  }, devices)
  assert.equal(failed.heroStatus, "ERROR")
  assert.equal(failed.mirroring[0].stateLabel, "ERROR")
})

test("disconnect is targeted and remains pending until its stream disappears", () => {
  const streamingData = fixture("streaming")
  const streaming = context.derive(streamingData.status, streamingData.devices)
  assert.equal(context.canDisconnect(streaming, streaming.mirroring[0].ip), true)

  const pending = context.applyPending(streaming, "disconnect", streaming.mirroring[0].ip)
  assert.equal(pending.mirroring[0].stateLabel, "DISCONNECTING")
  assert.equal(pending.mirroring[0].canDisconnect, false)
  assert.equal(context.pendingFinished("disconnect", streaming.mirroring[0].ip, streamingData.status), false)
  assert.equal(context.pendingFinished("disconnect", streaming.mirroring[0].ip, fixture("available").status), true)
})

test("disconnect is read-only for unsupported or multiple streams", () => {
  const devices = fixture("available").devices
  const unsupported = context.derive({
    ok: true,
    state: "streaming",
    streams: [{ device: "Office", device_ip: "10.0.0.30", state: "streaming" }]
  }, devices)
  assert.equal(unsupported.mirroring[0].model, "AudioAccessory6,1")
  assert.equal(unsupported.mirroring[0].stateLabel, "UNSUPPORTED DEVICE")
  assert.equal(unsupported.heroStatus, "UNSUPPORTED DEVICE")
  assert.equal(unsupported.mirroring[0].canDisconnect, false)
  assert.equal(context.canDisconnect(unsupported, "10.0.0.30"), false)

  const multiple = context.derive({
    ok: true,
    state: "streaming",
    streams: [
      { device: "Living Room", device_ip: "10.0.0.20", state: "streaming" },
      { device: "Bedroom", device_ip: "10.0.0.10", state: "streaming" }
    ]
  }, devices)
  assert.equal(multiple.mirroring.length, 2)
  assert.equal(multiple.mirroring.every(row => !row.canDisconnect), true)
  assert.equal(context.canDisconnect(multiple, "10.0.0.20"), false)
})

test("streams remain authoritative when discovery is missing or stale", () => {
  const model = context.derive({
    ok: true,
    state: "streaming",
    streams: [{ device: "Patio", device_ip: "10.0.0.99", state: "streaming" }]
  }, {
    ok: true,
    state: "streaming",
    devices: [
      { name: "Bedroom", model: "AppleTV11,1", ip: "10.0.0.10" }
    ]
  })

  assert.equal(model.heroStatus, "MIRRORING")
  assert.deepEqual(Array.from(model.mirroring, row => [row.name, row.ip, row.model]), [
    ["Patio", "10.0.0.99", ""]
  ])
  assert.deepEqual(Array.from(model.available, row => row.name), ["Bedroom"])
  assert.equal(model.mirroring[0].canDisconnect, false)
  assert.equal(model.available[0].canConnect, false)
})

test("a matching device enriches a stream without replacing its reported identity", () => {
  const model = context.derive({
    ok: true,
    state: "streaming",
    streams: [{ device: "Reported Name", device_ip: "10.0.0.20", state: "streaming" }]
  }, {
    ok: true,
    state: "streaming",
    devices: [
      { name: "Discovered Name", model: "AppleTV14,1", ip: "10.0.0.20" }
    ]
  })

  assert.equal(model.mirroring[0].name, "Reported Name")
  assert.equal(model.mirroring[0].ip, "10.0.0.20")
  assert.equal(model.mirroring[0].model, "AppleTV14,1")
  assert.equal(model.mirroring[0].canDisconnect, true)
})

test("mixed and multiple stream data stays visible, sorted, and read-only", () => {
  const model = context.derive({
    ok: true,
    state: "streaming",
    streams: [
      { device: "Zulu", device_ip: "10.0.0.30", state: "streaming" },
      { device: "Alpha", device_ip: "10.0.0.20", state: "future_state" },
      { device: "Alpha", device_ip: "10.0.0.10", state: "connecting" }
    ]
  }, {
    ok: true,
    state: "streaming",
    devices: [
      { name: "Bedroom", model: "AppleTV11,1", ip: "10.0.0.10" },
      { name: "Living Room", model: "AppleTV14,1", ip: "10.0.0.20" },
      { name: "Office", model: "AudioAccessory6,1", ip: "10.0.0.30" },
      { name: "Available", model: "AppleTV14,1", ip: "10.0.0.40" }
    ]
  })

  assert.equal(model.heroStatus, "MULTIPLE STREAMS")
  assert.deepEqual(Array.from(model.mirroring, row => row.ip), [
    "10.0.0.10",
    "10.0.0.20",
    "10.0.0.30"
  ])
  assert.deepEqual(Array.from(model.mirroring, row => row.stateLabel), [
    "CONNECTING",
    "UNKNOWN STATE",
    "UNSUPPORTED DEVICE"
  ])
  assert.equal(model.mirroring.every(row => !row.canDisconnect), true)
  assert.equal(model.available.every(row => !row.canConnect), true)
})

test("an unfamiliar lone Apple TV stream remains safely disconnectable", () => {
  const devices = fixture("available").devices
  const model = context.derive({
    ok: true,
    state: "future_state",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "future_state" }]
  }, devices)

  assert.equal(model.heroStatus, "UNKNOWN STATE")
  assert.equal(model.mirroring[0].stateLabel, "UNKNOWN STATE")
  assert.equal(model.available.every(row => !row.canConnect), true)
  assert.equal(model.mirroring[0].canDisconnect, true)
  assert.equal(context.canDisconnect(model, "10.0.0.20"), true)
})

test("hero status prioritizes multiple streams and unsupported devices", () => {
  const devices = fixture("available").devices
  const unsupportedPrompt = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{
      device: "Office",
      device_ip: "10.0.0.30",
      state: "pin_required",
      credential_kind: "pin"
    }]
  }, devices)
  assert.equal(unsupportedPrompt.heroStatus, "UNSUPPORTED DEVICE")
  assert.equal(unsupportedPrompt.mirroring[0].needsCredential, false)
  assert.equal(context.canSubmitCredential(unsupportedPrompt, "10.0.0.30", "pin", "1234"), false)
  assert.equal(context.canCancelCredential(unsupportedPrompt, "10.0.0.30"), false)

  const multiple = context.derive({
    ok: true,
    state: "pin_required",
    streams: [
      { device: "Office", device_ip: "10.0.0.30", state: "streaming" },
      {
        device: "Living Room",
        device_ip: "10.0.0.20",
        state: "pin_required",
        credential_kind: "password"
      }
    ]
  }, devices)
  assert.equal(multiple.heroStatus, "MULTIPLE STREAMS")
})

test("pending overlays preserve newly authoritative multiple and unsupported states", () => {
  const devices = fixture("available").devices
  const multiple = context.derive({
    ok: true,
    state: "streaming",
    streams: [
      { device: "Bedroom", device_ip: "10.0.0.10", state: "streaming" },
      { device: "Living Room", device_ip: "10.0.0.20", state: "connecting" }
    ]
  }, devices, "connect", "10.0.0.20")
  assert.equal(multiple.heroStatus, "MULTIPLE STREAMS")
  assert.equal(multiple.mirroring.every(row => !row.canDisconnect), true)

  const unsupported = context.derive({
    ok: true,
    state: "pin_required",
    streams: [{
      device: "Office",
      device_ip: "10.0.0.30",
      state: "pin_required",
      credential_kind: "pin"
    }]
  }, devices, "credential", "10.0.0.30")
  assert.equal(unsupported.heroStatus, "UNSUPPORTED DEVICE")
  assert.equal(unsupported.mirroring[0].stateLabel, "UNSUPPORTED DEVICE")
  assert.equal(unsupported.mirroring[0].pending, false)
  assert.equal(unsupported.mirroring[0].canDisconnect, false)
})

test("request policy serializes work, prioritizes actions, and skips overlapping polls", () => {
  assert.equal(context.requestDecision(false, "", false, "poll"), "start")
  assert.equal(context.requestDecision(true, "poll", false, "action"), "queue-action")
  assert.equal(context.requestDecision(true, "poll", true, "action"), "reject")
  assert.equal(context.requestDecision(true, "action", false, "action"), "reject")
  assert.equal(context.requestDecision(true, "action", false, "poll"), "coalesce-poll")
  assert.equal(context.completionDecision("poll", true), "action")
})

test("queued work preempts the next poll stage after the current response", () => {
  assert.equal(context.pollResponseDecision("status", false), "devices")
  assert.equal(context.pollResponseDecision("status", true), "action")
  assert.equal(context.pollResponseDecision("devices", false), "complete")
  assert.equal(context.pollResponseDecision("devices", true), "action")
})

test("poll failures dispatch non-secret work but drop queued credentials", () => {
  const connect = { action: "connect", payload: context.targetedRequest("connect", "10.0.0.20") }
  const disconnect = { action: "disconnect", payload: context.targetedRequest("disconnect", "10.0.0.20") }
  const credential = {
    action: "credential",
    payload: context.credentialRequest("10.0.0.20", "1234")
  }
  assert.equal(context.failureCompletionDecision("poll", connect), "action")
  assert.equal(context.failureCompletionDecision("poll", disconnect), "action")
  assert.equal(context.failureCompletionDecision("poll", credential), "drop-credential")
  assert.equal(context.failureCompletionDecision("poll", null), "fail")
  assert.equal(context.failureCompletionDecision("action", connect), "fail")
})

test("every completed action schedules exactly one immediate refresh", () => {
  assert.equal(context.completionDecision("action", false), "refresh")
  assert.equal(context.completionDecision("action", true), "refresh")
  assert.equal(context.completionDecision("poll", false), "idle")
})

test("command errors are visible without disabling an otherwise healthy model", () => {
  const model = context.withError(derive("available"), "Connect was rejected")
  assert.equal(model.error, "Connect was rejected")
  assert.equal(model.daemonAvailable, true)
  assert.equal(context.canConnect(model, "10.0.0.10"), true)
})

test("command error recovery waits for a complete successful refresh", () => {
  const error = "Connect was rejected"
  assert.equal(context.commandErrorAfterRefresh(error, false), error)

  const recovered = context.recoverCommandError(derive("available"), error)
  assert.equal(recovered.model.error, "")
  assert.equal(recovered.nextError, "")
})

test("socket selection tries the runtime path before the legacy fallback", () => {
  assert.deepEqual(Array.from(context.socketPaths("/run/user/1000")), [
    "/run/user/1000/doubletake.sock",
    "/tmp/doubletake.sock"
  ])
  assert.deepEqual(Array.from(context.socketPaths("")), ["/tmp/doubletake.sock"])
  assert.equal(
    context.fallbackSocketPath("/run/user/1000", "/run/user/1000/doubletake.sock", false),
    "/tmp/doubletake.sock"
  )
  assert.equal(
    context.fallbackSocketPath("/run/user/1000", "/run/user/1000/doubletake.sock", true),
    ""
  )
  assert.equal(context.fallbackSocketPath("/run/user/1000", "/tmp/doubletake.sock", false), "")
  assert.equal(context.fallbackSocketPath("", "/tmp/doubletake.sock", false), "")
})

test("failure categories are stable, distinguishable, and contain no daemon detail", () => {
  const kinds = [
    "socketUnavailable",
    "socketTimeout",
    "socketClosed",
    "requestRejected",
    "malformedResponse",
    "discoveryReported",
    "streamReported"
  ]
  const messages = kinds.map(kind => context.failureMessage(kind))
  assert.equal(new Set(messages).size, messages.length)
  assert.equal(messages.some(message => message.includes("1234")), false)
  assert.throws(() => context.failureMessage("unknown"), {
    message: "Unknown sanitized failure category."
  })

  assert.throws(
    () => context.parseResponse({ ok: false, state: "error", error: "credential 1234 rejected" }, "action"),
    { message: context.failureMessage("requestRejected") }
  )
  assert.throws(
    () => context.parseResponse({ ok: false, state: "error", devices: [], error: "discovery secret" }, "devices"),
    { message: context.failureMessage("discoveryReported") }
  )

  const credentialFailure = context.credentialTransportMessage("socketTimeout")
  assert.equal(credentialFailure.startsWith(context.failureMessage("socketTimeout")), true)
  assert.equal(credentialFailure.includes("cleared"), true)
  assert.equal(credentialFailure.includes("1234"), false)
})

test("malformed JSON and invalid required field types are rejected safely", () => {
  const malformed = context.failureMessage("malformedResponse")
  const cases = [
    ["not json", "status"],
    [{ ok: "yes", state: "idle" }, "status"],
    [{ ok: true, state: 7 }, "status"],
    [{ ok: true, state: "idle", streams: {} }, "status"],
    [{ ok: true, state: "idle", streams: [{ device: 7, device_ip: "10.0.0.1", state: "idle" }] }, "status"],
    [{ ok: true, state: "idle" }, "devices"],
    [{ ok: true, state: "idle", devices: [{ name: "TV", model: false, ip: "10.0.0.1" }] }, "devices"],
    [{ ok: true, state: "idle", devices: [], error: 1234 }, "devices"]
  ]
  for (const [value, kind] of cases)
    assert.throws(() => context.parseResponse(value, kind), { message: malformed })
})

test("omitted optional fields and unknown future data remain forward-compatible", () => {
  const status = context.parseResponse({
    ok: true,
    state: "future_daemon_state",
    future_top_level: { enabled: true }
  }, "status")
  const devices = context.parseResponse({
    ok: true,
    state: "future_discovery_state",
    devices: [{
      name: "Living Room",
      model: "AppleTV14,1",
      ip: "10.0.0.20",
      future_device_field: 42
    }],
    future_top_level: true
  }, "devices")
  const model = context.derive(status, devices)
  assert.equal(model.heroStatus, "AVAILABLE")
  assert.equal(model.available[0].name, "Living Room")
})

test("refresh publication is atomic when the second response is malformed", () => {
  const current = derive("available")
  const nextStatus = {
    ok: true,
    state: "streaming",
    streams: [{ device: "Living Room", device_ip: "10.0.0.20", state: "streaming" }]
  }
  let published = current
  assert.throws(() => {
    const status = context.parseResponse(nextStatus, "status")
    const devices = context.parseResponse({ ok: true, state: "idle", devices: "invalid" }, "devices")
    published = context.derive(status, devices)
  }, { message: context.failureMessage("malformedResponse") })
  assert.equal(published, current)
  assert.equal(published.heroStatus, "AVAILABLE")
  assert.equal(published.mirroring.length, 0)
})

test("errors persist across failed refreshes and clear only after verified recovery", () => {
  const error = context.failureMessage("socketTimeout")
  assert.equal(context.commandErrorAfterRefresh(error, false), error)
  assert.equal(context.commandErrorAfterRefresh(error, true), "")

  const pending = context.applyPending(
    context.withError(derive("available"), error),
    "connect",
    "10.0.0.20"
  )
  assert.equal(pending.error, error)

  const recovered = context.recoverCommandError(
    context.derive(
      context.parseResponse(fixture("available").status, "status"),
      context.parseResponse(fixture("available").devices, "devices")
    ),
    error
  )
  assert.equal(recovered.model.heroStatus, "AVAILABLE")
  assert.equal(recovered.model.error, "")
  assert.equal(recovered.nextError, "")
})

test("Double Take stream and discovery errors are derived without exposing response values", () => {
  const devices = fixture("available").devices
  const streamError = context.derive(context.parseResponse({
    ok: true,
    state: "error",
    error: "credential 1234 failed",
    streams: [{
      device: "Living Room",
      device_ip: "10.0.0.20",
      state: "error",
      error: "password swordfish failed"
    }]
  }, "status"), context.parseResponse(devices, "devices"))
  assert.equal(streamError.error, context.failureMessage("streamReported"))
  assert.equal(streamError.error.includes("1234"), false)
  assert.equal(streamError.error.includes("swordfish"), false)

  const discoveryError = context.derive(
    context.parseResponse(fixture("idle").status, "status"),
    context.parseResponse({
      ok: true,
      state: "error",
      error: "internal discovery detail",
      devices: []
    }, "devices")
  )
  assert.equal(discoveryError.error, context.failureMessage("discoveryReported"))
})
