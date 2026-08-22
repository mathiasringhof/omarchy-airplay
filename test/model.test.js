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

test("states owned by later tickets remain unknown", () => {
  assert.equal(context.streamLabel("connecting"), "UNKNOWN STATE")
  assert.equal(context.streamLabel("pin_required"), "UNKNOWN STATE")
  assert.equal(context.streamLabel("future_state"), "UNKNOWN STATE")
})
