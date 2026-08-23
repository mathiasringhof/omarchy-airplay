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

function socketPaths(runtimeDir) {
  runtimeDir = String(runtimeDir || "")
  if (runtimeDir === "") return ["/tmp/doubletake.sock"]
  return [runtimeDir + "/doubletake.sock", "/tmp/doubletake.sock"]
}

function fallbackSocketPath(runtimeDir, currentPath, payloadWriteAttempted) {
  var paths = socketPaths(runtimeDir)
  if (payloadWriteAttempted || paths.length < 2 || currentPath !== paths[0]) return ""
  return paths[1]
}

function failureMessage(kind) {
  if (kind === "socketUnavailable") return "The Double Take socket is unavailable."
  if (kind === "socketTimeout") return "Double Take did not respond within five seconds."
  if (kind === "socketClosed") return "Double Take closed the socket without a response."
  if (kind === "requestRejected") return "Double Take rejected the request."
  if (kind === "malformedResponse") return "Double Take returned a malformed response."
  if (kind === "discoveryReported") return "Double Take reported an Apple TV discovery error."
  if (kind === "streamReported") return "Double Take reported a mirroring stream error."
  throw new Error("Unknown sanitized failure category.")
}

function credentialTransportMessage(kind) {
  return failureMessage(kind) + " The submitted credential was cleared. Enter it again."
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(object, key) {
  if (typeof object[key] !== "string")
    throw new Error(failureMessage("malformedResponse"))
  return object[key]
}

function parseResponse(raw, kind) {
  var value
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch (_) {
    throw new Error(failureMessage("malformedResponse"))
  }

  if (!isObject(value)) throw new Error(failureMessage("malformedResponse"))
  if (typeof value.ok !== "boolean") throw new Error(failureMessage("malformedResponse"))
  if (value.error !== undefined && typeof value.error !== "string")
    throw new Error(failureMessage("malformedResponse"))
  if (!value.ok)
    throw new Error(failureMessage(kind === "devices" ? "discoveryReported" : "requestRejected"))
  requiredString(value, "state")

  if (kind === "status") {
    if (value.streams !== undefined && !Array.isArray(value.streams))
      throw new Error(failureMessage("malformedResponse"))
    var streams = value.streams || []
    for (var i = 0; i < streams.length; i++) {
      if (!isObject(streams[i])) throw new Error(failureMessage("malformedResponse"))
      requiredString(streams[i], "device")
      requiredString(streams[i], "device_ip")
      requiredString(streams[i], "state")
    }
  }

  if (kind === "devices") {
    if (!Array.isArray(value.devices)) throw new Error(failureMessage("malformedResponse"))
    for (var j = 0; j < value.devices.length; j++) {
      if (!isObject(value.devices[j])) throw new Error(failureMessage("malformedResponse"))
      requiredString(value.devices[j], "name")
      requiredString(value.devices[j], "model")
      requiredString(value.devices[j], "ip")
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
    if (stream.unsupported) {
      mirroring.push(copyRow(stream, { canDisconnect: false }))
    } else if (action === "disconnect" && stream.ip === target) {
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
    heroStatus: (action === "connect" || action === "credential")
      && model.heroStatus !== "MULTIPLE STREAMS"
      && model.heroStatus !== "UNSUPPORTED DEVICE"
      ? "CONNECTING"
      : model.heroStatus,
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

function failureCompletionDecision(operation, queuedWork) {
  if (operation !== "poll" || !queuedWork) return "fail"
  return isCredentialWork(queuedWork) ? "drop-credential" : "action"
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

function responseError(status, devices) {
  if (status.error) return failureMessage("streamReported")
  var streams = status.streams || []
  for (var i = 0; i < streams.length; i++)
    if (streams[i].state === "error" || streams[i].error) return failureMessage("streamReported")
  if (devices.error) return failureMessage("discoveryReported")
  return ""
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
    var unsupported = !!match && !supported
    var streamCredentialKind = credentialKind(stream)
    usedIPs[stream.device_ip] = true
    mirroring.push({
      name: stream.device,
      model: match ? match.model : "",
      ip: stream.device_ip,
      state: stream.state,
      stateLabel: unsupported ? "UNSUPPORTED DEVICE" : streamLabel(stream.state, streamCredentialKind),
      supported: supported,
      unsupported: unsupported,
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
      needsCredential: false,
      credentialKind: "",
      pending: false,
      canConnect: streams.length === 0 && !pendingAction,
      canDisconnect: false,
      actionKind: "connect"
    })
  }

  mirroring.sort(compareRows)
  available.sort(compareRows)

  var error = responseError(status, devices)
  var heroStatus = mirroring.length > 1
    ? "MULTIPLE STREAMS"
    : mirroring.length === 1
    ? mirroring[0].stateLabel
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
