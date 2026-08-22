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
  property bool requestSent: false
  property string serializedRequest: ""
  property var responseHandler: null
  property int generation: 0

  function start() {
    generation++
    visibleModel = Model.loadingModel()
    active = true
    refresh()
  }

  function stop() {
    generation++
    active = false
    busy = false
    requestSent = false
    serializedRequest = ""
    responseHandler = null
    requestTimeout.stop()
    socket.connected = false
  }

  function refresh() {
    if (!active || busy) return
    busy = true
    var refreshGeneration = generation
    request("status", function(statusRaw) {
      if (!active || generation !== refreshGeneration) return
      var status
      try {
        status = Model.parseResponse(statusRaw, "status")
      } catch (error) {
        failRefresh(error.message)
        return
      }
      request("devices", function(devicesRaw) {
        if (!active || generation !== refreshGeneration) return
        try {
          var devices = Model.parseResponse(devicesRaw, "devices")
          visibleModel = Model.derive(status, devices)
          busy = false
        } catch (error) {
          failRefresh(error.message)
        }
      })
    })
  }

  function request(command, callback) {
    responseHandler = callback
    requestSent = false
    serializedRequest = JSON.stringify({ cmd: command }) + "\n"
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
    if (active) visibleModel = Model.unavailableModel(message)
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
    onTriggered: root.failRefresh("Double Take did not respond within five seconds.")
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
        root.failRefresh("Double Take closed the socket without a response.")
      }
    }
    onError: function(_) { root.failRefresh("The Double Take daemon is unavailable.") }
  }
}
