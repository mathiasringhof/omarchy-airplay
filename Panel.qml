import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

Panel {
  id: root

  moduleName: "mathias.airplay"
  ipcTarget: "mathias.airplay"

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property var state: controller.visibleModel

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) controller.start()
    else controller.stop()
  }

  Controller { id: controller }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: "AirPlay"
    iconComponent: Component {
      AirPlayIcon { color: root.foreground }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(560))

    Flickable {
      anchors.fill: parent
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      flickableDirection: Flickable.VerticalFlick
      interactive: contentHeight > height
      ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "AirPlay"
          meta: root.state.heroStatus
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            AirPlayIcon {
              width: Style.font.display
              height: Style.font.display
              color: root.foreground
            }
          }
        }

        Text {
          visible: root.state.error !== ""
          width: parent.width
          text: root.state.error
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: !root.state.loading && root.state.daemonAvailable
            && root.state.mirroring.length === 0 && root.state.available.length === 0
          width: parent.width
          text: "No Apple TVs are currently known to Double Take."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
          topPadding: Style.space(12)
          bottomPadding: Style.space(12)
        }

        AppleTVSection {
          visible: root.state.mirroring.length > 0
          width: parent.width
          title: "MIRRORING"
          rows: root.state.mirroring
        }

        PanelSeparator {
          visible: root.state.mirroring.length > 0 && root.state.available.length > 0
          width: parent.width
          foreground: root.foreground
        }

        AppleTVSection {
          visible: root.state.available.length > 0
          width: parent.width
          title: "AVAILABLE"
          rows: root.state.available
        }
      }
    }
  }

  component AppleTVSection: Column {
    required property string title
    required property var rows

    spacing: Style.space(8)

    PanelSectionHeader {
      width: parent.width
      text: parent.title
      foreground: root.foreground
      fontFamily: root.fontFamily
    }

    Repeater {
      model: parent.rows

      Item {
        id: appleTVRow
        required property var modelData
        width: parent.width
        implicitHeight: rowHeader.implicitHeight + credentialForm.height

        function submitCredential() {
          controller.submitCredential(
            modelData.ip,
            modelData.credentialKind,
            credentialField.text
          )
        }

        Item {
          id: rowHeader
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          implicitHeight: Math.max(labels.implicitHeight, actionButton.implicitHeight) + Style.space(10)

          Column {
            id: labels
            anchors.left: parent.left
            anchors.right: stateLabel.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              text: modelData.name
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              text: (modelData.model ? modelData.model + " · " : "") + modelData.ip
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          Text {
            id: stateLabel
            anchors.right: actionButton.visible ? actionButton.left : parent.right
            anchors.rightMargin: actionButton.visible ? Style.space(8) : 0
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.stateLabel
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          PanelActionButton {
            id: actionButton
            visible: !modelData.needsCredential
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: modelData.actionKind === "connect" ? "+" : "×"
            tooltipText: modelData.actionKind === "connect" ? "Connect" : "Disconnect"
            foreground: root.foreground
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: modelData.actionKind === "connect" ? modelData.canConnect : modelData.canDisconnect
            onClicked: {
              if (modelData.actionKind === "connect") controller.connect(modelData.ip)
              else controller.disconnect(modelData.ip)
            }
          }
        }

        Item {
          id: credentialForm
          visible: modelData.needsCredential === true
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: rowHeader.bottom
          height: visible ? credentialField.implicitHeight + Style.space(8) : 0

          RegularExpressionValidator {
            id: pinValidator
            regularExpression: /[0-9]{0,4}/
          }

          TextField {
            id: credentialField
            readonly property string credentialIdentity: modelData.ip + "|" + modelData.credentialKind
            anchors.left: parent.left
            anchors.right: submitCredentialButton.left
            anchors.rightMargin: Style.space(6)
            placeholderText: modelData.credentialKind === "password" ? "Password" : "0000"
            password: modelData.credentialKind === "password"
            passwordMaskDelay: 0
            maximumLength: modelData.credentialKind === "password" ? 32767 : 4
            readOnly: root.state.mirroring.length !== 1
            validator: modelData.credentialKind === "pin" ? pinValidator : null
            inputMethodHints: modelData.credentialKind === "password"
              ? Qt.ImhSensitiveData | Qt.ImhNoPredictiveText
              : Qt.ImhDigitsOnly
            horizontalAlignment: modelData.credentialKind === "password" ? Text.AlignLeft : Text.AlignHCenter
            foreground: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            onAccepted: appleTVRow.submitCredential()
            onCredentialIdentityChanged: text = ""
            onReadOnlyChanged: if (readOnly) text = ""
            onVisibleChanged: if (!visible) text = ""
            Keys.onEscapePressed: controller.cancelCredential(modelData.ip)

            Connections {
              target: controller
              function onCredentialEpochChanged() { credentialField.text = "" }
            }
          }

          PanelActionButton {
            id: submitCredentialButton
            anchors.right: cancelCredentialButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: credentialField.verticalCenter
            iconText: "+"
            tooltipText: "Connect"
            foreground: root.foreground
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: controller.canSubmitCredential(modelData.ip, modelData.credentialKind, credentialField.text)
            onClicked: appleTVRow.submitCredential()
          }

          PanelActionButton {
            id: cancelCredentialButton
            anchors.right: parent.right
            anchors.verticalCenter: credentialField.verticalCenter
            iconText: "×"
            tooltipText: "Cancel"
            foreground: root.foreground
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: controller.canCancelCredential(modelData.ip)
            onClicked: controller.cancelCredential(modelData.ip)
          }
        }
      }
    }
  }
}
