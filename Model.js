function emptyModel(overrides) {
  var model = {
    loading: false,
    daemonAvailable: true,
    heroStatus: "NO APPLE TVS",
    error: "",
    mirroring: [],
    available: []
  }
  overrides = overrides || {}
  for (var key in overrides) model[key] = overrides[key]
  return model
}

function loadingModel() {
  return emptyModel({ loading: true, heroStatus: "LOADING" })
}

function unavailableModel(message) {
  return emptyModel({
    daemonAvailable: false,
    heroStatus: "DOUBLE TAKE UNAVAILABLE",
    error: String(message || "The Double Take daemon is unavailable.")
  })
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(object, key, context) {
  if (typeof object[key] !== "string")
    throw new Error(context + "." + key + " must be a string")
  return object[key]
}

function parseResponse(raw, kind) {
  var value
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch (_) {
    throw new Error("Double Take returned malformed JSON")
  }

  if (!isObject(value)) throw new Error("Double Take response must be an object")
  if (typeof value.ok !== "boolean") throw new Error("Double Take response.ok must be a boolean")
  if (value.error !== undefined && typeof value.error !== "string")
    throw new Error("Double Take response.error must be a string")
  if (!value.ok) throw new Error(value.error || "Double Take rejected the request")
  requiredString(value, "state", "response")

  if (kind === "status") {
    if (value.streams !== undefined && !Array.isArray(value.streams))
      throw new Error("Double Take response.streams must be an array")
    var streams = value.streams || []
    for (var i = 0; i < streams.length; i++) {
      if (!isObject(streams[i])) throw new Error("stream must be an object")
      requiredString(streams[i], "device", "stream")
      requiredString(streams[i], "device_ip", "stream")
      requiredString(streams[i], "state", "stream")
    }
  }

  if (kind === "devices") {
    if (!Array.isArray(value.devices)) throw new Error("Double Take response.devices must be an array")
    for (var j = 0; j < value.devices.length; j++) {
      if (!isObject(value.devices[j])) throw new Error("device must be an object")
      requiredString(value.devices[j], "name", "device")
      requiredString(value.devices[j], "model", "device")
      requiredString(value.devices[j], "ip", "device")
    }
  }

  return value
}

function compareRows(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.ip !== b.ip) return a.ip < b.ip ? -1 : 1
  return 0
}

function isAppleTV(device) {
  return String(device.model || "").indexOf("AppleTV") === 0
}

function streamLabel(state) {
  if (state === "streaming") return "MIRRORING"
  return "UNKNOWN STATE"
}

function derive(status, devices) {
  var deviceByIP = {}
  var appleTVs = []
  var deviceList = devices.devices || []
  var i

  for (i = 0; i < deviceList.length; i++) {
    var device = deviceList[i]
    deviceByIP[device.ip] = device
    if (isAppleTV(device)) appleTVs.push(device)
  }

  var usedIPs = {}
  var mirroring = []
  var streams = status.streams || []
  for (i = 0; i < streams.length; i++) {
    var stream = streams[i]
    var match = deviceByIP[stream.device_ip]
    usedIPs[stream.device_ip] = true
    mirroring.push({
      name: stream.device,
      model: match ? match.model : "",
      ip: stream.device_ip,
      state: stream.state,
      stateLabel: streamLabel(stream.state)
    })
  }

  var available = []
  for (i = 0; i < appleTVs.length; i++) {
    var tv = appleTVs[i]
    if (!usedIPs[tv.ip]) available.push({
      name: tv.name,
      model: tv.model,
      ip: tv.ip,
      state: "available",
      stateLabel: "AVAILABLE"
    })
  }

  mirroring.sort(compareRows)
  available.sort(compareRows)

  var error = status.error || devices.error || ""
  var heroStatus = mirroring.length > 0 ? "MIRRORING"
    : available.length > 0 ? "AVAILABLE"
    : "NO APPLE TVS"

  return emptyModel({
    heroStatus: heroStatus,
    error: error,
    mirroring: mirroring,
    available: available
  })
}
