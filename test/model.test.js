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
})

test("one ordinary stream moves its Apple TV to mirroring", () => {
  const model = derive("streaming")
  assert.equal(model.heroStatus, "MIRRORING")
  assert.equal(model.mirroring.length, 1)
  assert.equal(model.mirroring[0].stateLabel, "MIRRORING")
  assert.deepEqual(Array.from(model.available, row => row.name), ["Bedroom"])
})

test("connecting is presented while credential states remain owned by later tickets", () => {
  assert.equal(context.streamLabel("connecting"), "CONNECTING")
  assert.equal(context.streamLabel("pin_required"), "UNKNOWN STATE")
  assert.equal(context.streamLabel("future_state"), "UNKNOWN STATE")
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
