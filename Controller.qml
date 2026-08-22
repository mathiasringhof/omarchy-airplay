import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Scope {
  id: root

  property bool active: false
  property var visibleModel: Model.loadingModel()
  readonly property string socketPath: {
    var runtimeDir = Quickshell.env("XDG_RUNTIME_DIR")
    return runtimeDir === "" ? "/tmp/doubletake.sock" : runtimeDir + "/doubletake.sock"
  }

  property bool busy: false
  property string operation: ""
  property var queuedWork: null
  property string pendingAction: ""
  property string pendingTarget: ""
  property string actionError: ""
  property bool requestSent: false
  property string serializedRequest: ""
  property var responseHandler: null
  property int generation: 0

  function start() {
    generation++
    visibleModel = Model.loadingModel()
    pendingAction = ""
    pendingTarget = ""
    actionError = ""
    queuedWork = null
    active = true
    refresh()
  }

  function stop() {
    generation++
    active = false
    busy = false
    operation = ""
    queuedWork = null
    pendingAction = ""
    pendingTarget = ""
    requestSent = false
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
      var status
      try {
        status = Model.parseResponse(statusRaw, "status")
      } catch (error) {
        failRefresh(error.message)
        return
      }
      if (Model.pollResponseDecision("status", queuedWork !== null) === "action") {
        startQueuedWork()
        return
      }
      request({ cmd: "devices" }, function(devicesRaw) {
        if (!active || generation !== refreshGeneration) return
        try {
          var devices = Model.parseResponse(devicesRaw, "devices")
          if (Model.pendingFinished(pendingAction, pendingTarget, status)) {
            pendingAction = ""
            pendingTarget = ""
          }
          var recovered = Model.recoverCommandError(
            Model.derive(status, devices, pendingAction, pendingTarget),
            actionError
          )
          visibleModel = recovered.model
          actionError = recovered.nextError
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

  function scheduleAction(payload, action, target) {
    var decision = Model.requestDecision(busy, operation, queuedWork !== null, "action")
    if (decision !== "start" && decision !== "queue-action") return
    pendingAction = action
    pendingTarget = target
    actionError = ""
    visibleModel = Model.applyPending(Model.withError(visibleModel, ""), action, target)
    var work = { payload: payload, action: action, target: target }
    if (decision === "queue-action") {
      queuedWork = work
      return
    }
    busy = true
    operation = "action"
    runAction(work)
  }

  function runAction(work) {
    request(work.payload, function(raw) {
      try {
        Model.parseResponse(raw, "action")
      } catch (error) {
        actionFailed(error.message)
        return
      }
      refreshAfterAction()
    })
  }

  function actionFailed(message) {
    actionError = String(message || "Double Take rejected the request")
    pendingAction = ""
    pendingTarget = ""
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
    responseHandler = callback
    requestSent = false
    serializedRequest = JSON.stringify(payload) + "\n"
    requestTimeout.restart()
    socket.connected = true
  }

  function finishRequest(raw) {
    if (!busy || responseHandler === null) return
    var callback = responseHandler
    responseHandler = null
    requestSent = false
    serializedRequest = ""
    requestTimeout.stop()
    socket.connected = false
    callback(raw)
  }

  function failRefresh(message) {
    responseHandler = null
    requestSent = false
    serializedRequest = ""
    requestTimeout.stop()
    socket.connected = false
    busy = false
    operation = ""
    if (active) visibleModel = Model.unavailableModel(message)
  }

  function failCurrent(message) {
    responseHandler = null
    requestSent = false
    serializedRequest = ""
    requestTimeout.stop()
    socket.connected = false
    if (operation === "action") {
      actionFailed(message)
      return
    }
    failRefresh(message)
  }

  onActiveChanged: if (!active) polling.stop()

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
    onTriggered: root.failCurrent("Double Take did not respond within five seconds.")
  }

  Socket {
    id: socket
    path: root.socketPath
    connected: false

    parser: SplitParser {
      splitMarker: "\n"
      onRead: function(data) {
        if (String(data).trim() !== "") root.finishRequest(String(data))
      }
    }

    onConnectedChanged: {
      if (connected && root.busy && !root.requestSent) {
        root.requestSent = true
        write(root.serializedRequest)
        flush()
        root.serializedRequest = ""
      } else if (!connected && root.busy && root.requestSent && root.responseHandler !== null) {
        root.failCurrent("Double Take closed the socket without a response.")
      }
    }
    onError: function(_) { root.failCurrent("The Double Take daemon is unavailable.") }
  }
}
