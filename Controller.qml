import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Scope {
  id: root

  property bool active: false
  property var visibleModel: Model.loadingModel()
  property var verifiedModel: Model.loadingModel()
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR")
  property string currentSocketPath: Model.socketPaths(runtimeDir)[0]

  property bool busy: false
  property string operation: ""
  property var queuedWork: null
  property string pendingAction: ""
  property string pendingTarget: ""
  property string pendingCredentialKind: ""
  property var credentialRejection: null
  property string actionError: ""
  property bool payloadWriteAttempted: false
  property string serializedRequest: ""
  property var responseHandler: null
  property int generation: 0
  property int credentialEpoch: 0

  function clearCredentialSecrets() {
    var cleared = Model.clearCredentialState({
      credentialEpoch: credentialEpoch,
      serializedRequest: serializedRequest,
      queuedWork: queuedWork
    })
    credentialEpoch = cleared.credentialEpoch
    serializedRequest = cleared.serializedRequest
    queuedWork = cleared.queuedWork
  }

  function start() {
    clearCredentialSecrets()
    generation++
    visibleModel = Model.loadingModel()
    verifiedModel = Model.loadingModel()
    pendingAction = ""
    pendingTarget = ""
    pendingCredentialKind = ""
    credentialRejection = null
    actionError = ""
    queuedWork = null
    active = true
    refresh()
  }

  function stop() {
    clearCredentialSecrets()
    generation++
    active = false
    busy = false
    operation = ""
    queuedWork = null
    pendingAction = ""
    pendingTarget = ""
    pendingCredentialKind = ""
    credentialRejection = null
    payloadWriteAttempted = false
    serializedRequest = ""
    responseHandler = null
    requestTimeout.stop()
    socket.connected = false
  }

  function refresh() {
    if (!active) return
    var decision = Model.requestDecision(busy, operation, queuedWork !== null, "poll")
    if (decision === "coalesce-poll") return
    if (decision !== "start") return
    busy = true
    operation = "poll"
    runRefresh()
  }

  function runRefresh() {
    var refreshGeneration = generation
    request({ cmd: "status" }, function(statusRaw) {
      if (!active || generation !== refreshGeneration) return
      if (Model.pollResponseDecision("status", queuedWork !== null) === "action") {
        startQueuedWork()
        return
      }
      var status
      try {
        status = Model.parseResponse(statusRaw, "status")
      } catch (error) {
        failRefresh(error.message)
        return
      }
      request({ cmd: "devices" }, function(devicesRaw) {
        if (!active || generation !== refreshGeneration) return
        if (Model.pollResponseDecision("devices", queuedWork !== null) === "action") {
          startQueuedWork()
          return
        }
        try {
          var devices = Model.parseResponse(devicesRaw, "devices")
          var finishedAction = ""
          if (Model.pendingFinished(pendingAction, pendingTarget, status)) {
            finishedAction = pendingAction
            pendingAction = ""
            pendingTarget = ""
          }
          var derived = Model.derive(status, devices, pendingAction, pendingTarget)
          verifiedModel = derived
          var hadCredentialRejection = credentialRejection !== null
          var retainedRejection = Model.credentialRejectionAfterRefresh(credentialRejection, derived)
          if (retainedRejection !== null) {
            credentialRejection = retainedRejection
            actionError = retainedRejection.message
            visibleModel = Model.withError(derived, actionError)
          } else {
            credentialRejection = null
            if (finishedAction === "credential" || hadCredentialRejection) pendingCredentialKind = ""
            var recovered = Model.recoverCommandError(derived, actionError)
            visibleModel = recovered.model
            actionError = recovered.nextError
          }
          finishRefresh()
        } catch (error) {
          failRefresh(error.message)
        }
      })
    })
  }

  function finishRefresh() {
    var next = Model.completionDecision(operation, queuedWork !== null)
    if (next === "action") {
      startQueuedWork()
      return
    }
    busy = false
    operation = ""
  }

  function startQueuedWork() {
    var work = queuedWork
    // Drop the only queued reference before serializing the request. The
    // serialized buffer is cleared immediately after Socket.write below.
    queuedWork = null
    operation = "action"
    runAction(work)
  }

  function connect(target) {
    if (!Model.canConnect(visibleModel, target)) return
    scheduleAction(Model.targetedRequest("connect", target), "connect", target)
  }

  function disconnect(target) {
    if (!Model.canDisconnect(visibleModel, target)) return
    scheduleAction(Model.targetedRequest("disconnect", target), "disconnect", target)
  }

  function submitCredential(target, kind, value) {
    if (!canSubmitCredential(target, kind, value)) return false
    var payload = Model.credentialRequest(target, value)
    clearCredentialSecrets()
    pendingCredentialKind = kind
    credentialRejection = null
    return scheduleAction(payload, "credential", target)
  }

  function actionCanBeScheduled() {
    var decision = Model.requestDecision(busy, operation, queuedWork !== null, "action")
    return decision === "start" || decision === "queue-action"
  }

  function canSubmitCredential(target, kind, value) {
    return actionCanBeScheduled() && Model.canSubmitCredential(visibleModel, target, kind, value)
  }

  function canCancelCredential(target) {
    return actionCanBeScheduled() && Model.canCancelCredential(visibleModel, target)
  }

  function cancelCredential(target) {
    if (!canCancelCredential(target)) return false
    var payload = Model.credentialCancelRequest(visibleModel, target)
    if (payload === null) return false
    clearCredentialSecrets()
    pendingCredentialKind = ""
    credentialRejection = null
    return scheduleAction(payload, "disconnect", target)
  }

  function scheduleAction(payload, action, target) {
    var decision = Model.requestDecision(busy, operation, queuedWork !== null, "action")
    if (decision !== "start" && decision !== "queue-action") return false
    pendingAction = action
    pendingTarget = target
    visibleModel = Model.applyPending(visibleModel, action, target)
    var work = { payload: payload, action: action, target: target }
    if (decision === "queue-action") {
      queuedWork = work
      return true
    }
    busy = true
    operation = "action"
    runAction(work)
    return true
  }

  function runAction(work) {
    request(work.payload, function(raw) {
      try {
        Model.parseResponse(raw, "action")
      } catch (error) {
        actionFailed(error.message, Model.responseIsRejection(raw) ? "rejected" : "response")
        return
      }
      refreshAfterAction()
    })
  }

  function actionFailed(message, failureKind) {
    var credentialAction = pendingAction === "credential"
    var target = pendingTarget
    if (credentialAction && failureKind === "rejected") {
      credentialRejection = Model.newCredentialRejection(target, pendingCredentialKind)
      actionError = credentialRejection.message
    } else {
      credentialRejection = null
      actionError = String(message || "Double Take rejected the request")
    }
    pendingAction = ""
    pendingTarget = ""
    clearCredentialSecrets()
    if (credentialRejection === null) pendingCredentialKind = ""
    visibleModel = Model.withError(visibleModel, actionError)
    refreshAfterAction()
  }

  function refreshAfterAction() {
    if (!active) return
    if (Model.completionDecision(operation, false) !== "refresh") return
    operation = "poll"
    runRefresh()
  }

  function request(payload, callback) {
    currentSocketPath = Model.socketPaths(runtimeDir)[0]
    responseHandler = callback
    payloadWriteAttempted = false
    serializedRequest = JSON.stringify(payload) + "\n"
    requestTimeout.restart()
    socket.connected = true
  }

  function tryFallbackSocket() {
    var fallback = Model.fallbackSocketPath(runtimeDir, currentSocketPath, payloadWriteAttempted)
    if (fallback === "") return false
    payloadWriteAttempted = false
    socket.connected = false
    currentSocketPath = fallback
    socket.connected = true
    return true
  }

  function clearCurrentRequest() {
    responseHandler = null
    payloadWriteAttempted = false
    serializedRequest = ""
    requestTimeout.stop()
    socket.connected = false
  }

  function finishRequest(raw) {
    if (!busy || responseHandler === null) return
    var callback = responseHandler
    responseHandler = null
    payloadWriteAttempted = false
    serializedRequest = ""
    requestTimeout.stop()
    socket.connected = false
    callback(raw)
  }

  function failRefresh(message) {
    clearCredentialSecrets()
    clearCurrentRequest()
    busy = false
    operation = ""
    queuedWork = null
    if (active) visibleModel = Model.unavailableModel(message)
  }

  function dropQueuedCredential(failureKind) {
    var message = Model.credentialTransportMessage(failureKind)
    clearCredentialSecrets()
    clearCurrentRequest()
    busy = false
    operation = ""
    queuedWork = null
    pendingAction = ""
    pendingTarget = ""
    pendingCredentialKind = ""
    credentialRejection = null
    actionError = message
    if (active) visibleModel = Model.withError(verifiedModel, message)
  }

  function failCurrent(failureKind) {
    if (!busy || responseHandler === null) return
    var completion = Model.failureCompletionDecision(operation, queuedWork)
    if (completion === "action") {
      clearCurrentRequest()
      startQueuedWork()
      return
    }
    if (completion === "drop-credential") {
      dropQueuedCredential(failureKind)
      return
    }
    var message = Model.failureMessage(failureKind)
    if (operation === "action") {
      clearCurrentRequest()
      actionFailed(message, "transport")
      return
    }
    failRefresh(message)
  }

  onActiveChanged: if (!active) polling.stop()
  Component.onDestruction: clearCredentialSecrets()

  Timer {
    id: polling
    interval: 3000
    repeat: true
    running: root.active
    onTriggered: root.refresh()
  }

  Timer {
    id: requestTimeout
    interval: 5000
    repeat: false
    onTriggered: root.failCurrent("socketTimeout")
  }

  Socket {
    id: socket
    path: root.currentSocketPath
    connected: false

    parser: SplitParser {
      splitMarker: "\n"
      onRead: function(data) {
        if (String(data).trim() !== "") root.finishRequest(String(data))
      }
    }

    onConnectedChanged: {
      if (connected && root.busy && !root.payloadWriteAttempted) {
        root.payloadWriteAttempted = true
        write(root.serializedRequest)
        flush()
        root.serializedRequest = ""
      } else if (!connected && root.busy && root.payloadWriteAttempted && root.responseHandler !== null) {
        root.failCurrent("socketClosed")
      }
    }
    onError: function(_) {
      if (root.busy && root.responseHandler !== null && root.tryFallbackSocket()) return
      root.failCurrent("socketUnavailable")
    }
  }
}
