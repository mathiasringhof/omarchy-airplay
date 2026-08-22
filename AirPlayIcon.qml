import QtQuick

Item {
  id: root

  property color color: "white"
  property real strokeWidth: Math.max(1.5, width * 0.075)

  implicitWidth: 24
  implicitHeight: 24

  Canvas {
    id: canvas
    anchors.fill: parent

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      ctx.strokeStyle = root.color
      ctx.fillStyle = root.color
      ctx.lineWidth = root.strokeWidth
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      var inset = root.strokeWidth
      var lower = height * 0.64
      ctx.beginPath()
      ctx.moveTo(width * 0.31, lower)
      ctx.lineTo(inset * 1.8, lower)
      ctx.quadraticCurveTo(inset, lower, inset, lower - inset)
      ctx.lineTo(inset, height * 0.2)
      ctx.quadraticCurveTo(inset, inset, inset * 2, inset)
      ctx.lineTo(width - inset * 2, inset)
      ctx.quadraticCurveTo(width - inset, inset, width - inset, height * 0.2)
      ctx.lineTo(width - inset, lower - inset)
      ctx.quadraticCurveTo(width - inset, lower, width - inset * 1.8, lower)
      ctx.lineTo(width * 0.69, lower)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(width * 0.5, height * 0.48)
      ctx.lineTo(width * 0.25, height * 0.9)
      ctx.lineTo(width * 0.75, height * 0.9)
      ctx.closePath()
      ctx.fill()
    }

    Connections {
      target: root
      function onColorChanged() { canvas.requestPaint() }
      function onStrokeWidthChanged() { canvas.requestPaint() }
    }
  }
}
