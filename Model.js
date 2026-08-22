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

function responseIsRejection(raw) {
  var value
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch (_) {
    return false
  }
  return isObject(value) && value.ok === false
}

function compareRows(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.ip !== b.ip) return a.ip < b.ip ? -1 : 1
  return 0
}

function isAppleTV(device) {
  return String(device.model || "").indexOf("AppleTV") === 0
}

function credentialKind(stream) {
  if (!stream || stream.state !== "pin_required") return ""
  if (stream.credential_kind === "pin" || stream.credential_kind === "password")
    return stream.credential_kind
  return ""
}

function credentialValid(kind, value) {
  value = String(value || "")
  if (kind === "password") return value.length > 0
  return kind === "pin" && /^\d{4}$/.test(value)
}

function credentialRequest(target, value) {
  return { cmd: "connect", target: String(target), pin: String(value) }
}

function isCredentialWork(work) {
  return !!work && work.action === "credential"
}

function clearCredentialState(state) {
  state = state || {}
  return {
    draft: "",
    credentialEpoch: Number(state.credentialEpoch || 0) + 1,
    serializedRequest: "",
    queuedWork: isCredentialWork(state.queuedWork) ? null : (state.queuedWork || null)
  }
}

function credentialRejectedMessage(kind) {
  if (kind === "pin") return "The PIN was rejected. Enter a fresh PIN and select Connect."
  if (kind === "password") return "The Password was rejected. Enter a fresh Password and select Connect."
  return "The credential was rejected. Enter a fresh value and select Connect."
}

function newCredentialRejection(target, kind) {
  return {
    target: String(target),
    kind: String(kind),
    message: credentialRejectedMessage(kind)
  }
}

function credentialRejectionAfterRefresh(rejection, model) {
  if (!rejection || !model) return null
  for (var i = 0; i < model.mirroring.length; i++) {
    var row = model.mirroring[i]
    if (row.ip === rejection.target && row.needsCredential && row.credentialKind === rejection.kind)
      return rejection
  }
  return null
}

function streamLabel(state, kind) {
  if (state === "streaming") return "MIRRORING"
  if (state === "connecting") return "CONNECTING"
  if (state === "pin_required") {
    if (kind === "password") return "PASSWORD REQUIRED"
    if (kind === "pin") return "PIN REQUIRED"
    return "UNKNOWN STATE"
  }
  if (state === "error") return "ERROR"
  return "UNKNOWN STATE"
}

function copyRow(row, overrides) {
  var result = {}
  var key
  for (key in row) result[key] = row[key]
  overrides = overrides || {}
  for (key in overrides) result[key] = overrides[key]
  return result
}

function streamForTarget(status, target) {
  var streams = status.streams || []
  for (var i = 0; i < streams.length; i++)
    if (streams[i].device_ip === target) return streams[i]
  return null
}

function pendingFinished(action, target, status) {
  if (!action || !target) return true
  var found = streamForTarget(status, target) !== null
  if (action === "connect") return found || !!status.error
  if (action === "credential") {
    var stream = streamForTarget(status, target)
    return stream === null || stream.state !== "pin_required" || !!status.error
  }
  if (action === "disconnect") return !found || !!status.error
  return true
}

function applyPending(model, action, target) {
  if (!action || !target) return model

  var i
  var mirroring = []
  var available = []
  for (i = 0; i < model.mirroring.length; i++) {
    var stream = model.mirroring[i]
    if (action === "disconnect" && stream.ip === target) {
      mirroring.push(copyRow(stream, { pending: true, canDisconnect: false, stateLabel: "DISCONNECTING" }))
    } else if (action === "credential" && stream.ip === target) {
      mirroring.push(copyRow(stream, {
        state: "connecting",
        stateLabel: "CONNECTING",
        needsCredential: false,
        credentialKind: "",
        pending: true,
        canDisconnect: false
      }))
    } else {
      mirroring.push(copyRow(stream, { canDisconnect: false }))
    }
  }
  for (i = 0; i < model.available.length; i++) {
    var tv = model.available[i]
    if (action === "connect" && tv.ip === target) {
      available.push(copyRow(tv, {
        state: "connecting",
        stateLabel: "CONNECTING",
        pending: true,
        canConnect: false
      }))
    } else {
      available.push(copyRow(tv, { canConnect: false }))
    }
  }
  mirroring.sort(compareRows)
  return emptyModel({
    loading: model.loading,
    daemonAvailable: model.daemonAvailable,
    heroStatus: action === "connect" || action === "credential" ? "CONNECTING" : model.heroStatus,
    error: model.error,
    mirroring: mirroring,
    available: available
  })
}

function withError(model, message) {
  return emptyModel({
    loading: model.loading,
    daemonAvailable: model.daemonAvailable,
    heroStatus: model.heroStatus,
    error: String(message || ""),
    mirroring: model.mirroring,
    available: model.available
  })
}

function canConnect(model, target) {
  if (!model || model.loading || !model.daemonAvailable || model.mirroring.length > 0) return false
  for (var i = 0; i < model.available.length; i++)
    if (model.available[i].ip === target && model.available[i].canConnect) return true
  return false
}

function canDisconnect(model, target) {
  if (!model || model.loading || !model.daemonAvailable) return false
  for (var i = 0; i < model.mirroring.length; i++)
    if (model.mirroring[i].ip === target && model.mirroring[i].canDisconnect) return true
  return false
}

function canSubmitCredential(model, target, kind, value) {
  if (!model || model.loading || !model.daemonAvailable || model.mirroring.length !== 1
      || !credentialValid(kind, value)) return false
  for (var i = 0; i < model.mirroring.length; i++) {
    var row = model.mirroring[i]
    if (row.ip === target && row.needsCredential && row.credentialKind === kind) return true
  }
  return false
}

function canCancelCredential(model, target) {
  if (!model || model.loading || !model.daemonAvailable || model.mirroring.length !== 1) return false
  for (var i = 0; i < model.mirroring.length; i++)
    if (model.mirroring[i].ip === target && model.mirroring[i].needsCredential) return true
  return false
}

function credentialCancelRequest(model, target) {
  return canCancelCredential(model, target) ? targetedRequest("disconnect", target) : null
}

function requestDecision(busy, operation, queuedWork, requestedKind) {
  if (!busy) return "start"
  if (requestedKind === "action" && operation === "poll" && !queuedWork) return "queue-action"
  if (requestedKind === "poll") return "coalesce-poll"
  return "reject"
}

function completionDecision(operation, queuedWork) {
  if (operation === "action") return "refresh"
  if (operation === "poll" && queuedWork) return "action"
  return "idle"
}

function pollResponseDecision(stage, queuedWork) {
  if (queuedWork) return "action"
  return stage === "status" ? "devices" : "complete"
}

function recoverCommandError(model, commandError) {
  return {
    model: model,
    nextError: commandErrorAfterRefresh(commandError, true)
  }
}

function commandErrorAfterRefresh(commandError, successful) {
  return successful ? "" : String(commandError || "")
}

function targetedRequest(command, target) {
  return { cmd: String(command), target: String(target) }
}

function derive(status, devices, pendingAction, pendingTarget) {
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
  var supportedStreamCount = 0
  for (i = 0; i < streams.length; i++) {
    var supportedDevice = deviceByIP[streams[i].device_ip]
    if (supportedDevice && isAppleTV(supportedDevice)) supportedStreamCount++
  }
  for (i = 0; i < streams.length; i++) {
    var stream = streams[i]
    var match = deviceByIP[stream.device_ip]
    var supported = !!match && isAppleTV(match)
    var streamCredentialKind = credentialKind(stream)
    usedIPs[stream.device_ip] = true
    mirroring.push({
      name: stream.device,
      model: match ? match.model : "",
      ip: stream.device_ip,
      state: stream.state,
      stateLabel: streamLabel(stream.state, streamCredentialKind),
      needsCredential: streamCredentialKind !== "" && supported,
      credentialKind: streamCredentialKind,
      pending: false,
      canConnect: false,
      canDisconnect: stream.state !== "pin_required"
        && streams.length === 1 && supportedStreamCount === 1 && supported,
      actionKind: "disconnect"
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
      stateLabel: "AVAILABLE",
      pending: false,
      canConnect: streams.length === 0 && !pendingAction,
      canDisconnect: false,
      actionKind: "connect"
    })
  }

  mirroring.sort(compareRows)
  available.sort(compareRows)

  var error = status.error || devices.error || ""
  var hasConnecting = false
  var hasStreamError = false
  var hasPINRequired = false
  var hasPasswordRequired = false
  var hasUnknownCredentialState = false
  for (i = 0; i < mirroring.length; i++)
    if (mirroring[i].state === "connecting") hasConnecting = true
    else if (mirroring[i].state === "error") hasStreamError = true
    else if (mirroring[i].credentialKind === "password") hasPasswordRequired = true
    else if (mirroring[i].credentialKind === "pin") hasPINRequired = true
    else if (mirroring[i].state === "pin_required") hasUnknownCredentialState = true
  var heroStatus = mirroring.length > 1
    ? "MULTIPLE STREAMS"
    : mirroring.length > 0
    ? (hasPasswordRequired ? "PASSWORD REQUIRED"
      : hasPINRequired ? "PIN REQUIRED"
      : hasUnknownCredentialState ? "UNKNOWN STATE"
      : hasConnecting ? "CONNECTING"
      : hasStreamError ? "ERROR"
      : "MIRRORING")
    : available.length > 0 ? "AVAILABLE"
    : "NO APPLE TVS"

  var model = emptyModel({
    heroStatus: heroStatus,
    error: error,
    mirroring: mirroring,
    available: available
  })
  return applyPending(model, pendingAction, pendingTarget)
}
