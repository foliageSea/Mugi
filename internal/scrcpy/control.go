// Package scrcpy implements the client side of the scrcpy server protocol
// (control messages, device messages and media stream framing).
//
// The wire format follows scrcpy v4.x. Reference: Genymobile/scrcpy
// app/src/control_msg.h and app/tests/test_control_msg_serialize.c.
package scrcpy

import (
	"encoding/binary"
	"fmt"
)

// Control message types (client -> device).
const (
	CtrlInjectKeycode      = 0
	CtrlInjectText         = 1
	CtrlInjectTouch        = 2
	CtrlInjectScroll       = 3
	CtrlBackOrScreenOn     = 4
	CtrlExpandNotification = 5
	CtrlExpandSettings     = 6
	CtrlCollapsePanels     = 7
	CtrlGetClipboard       = 8
	CtrlSetClipboard       = 9
	CtrlSetDisplayPower    = 10
	CtrlRotateDevice       = 11
	CtrlUhidCreate         = 12
	CtrlUhidInput          = 13
	CtrlUhidDestroy        = 14
	CtrlOpenHardKeyboard   = 15
	CtrlStartApp           = 16
	CtrlResetVideo         = 17
	CtrlCameraSetTorch     = 18
	CtrlCameraZoomIn       = 19
	CtrlCameraZoomOut      = 20
	CtrlResizeDisplay      = 21
	CtrlScanFile           = 22
)

// Device message types (device -> client).
const (
	DevMsgClipboard    = 0
	DevMsgAckClipboard = 1
	DevMsgUhidOutput   = 2
)

// Key event actions.
const (
	ActionDown = 0
	ActionUp   = 1
)

// Motion buttons.
const (
	ButtonPrimary   = 1
	ButtonSecondary = 2
	ButtonTertiary  = 4
)

// Well-known pointer ids.
const (
	PointerIDMouse         = 0xFFFFFFFFFFFFFFFF
	PointerIDGenericFinger = 0xFFFFFFFFFFFFFFFE
	PointerIDVirtualFinger = 0xFFFFFFFFFFFFFFFD
)

// Clipboard text limits.
const (
	MaxInjectText   = 300
	MaxClipboardLen = (1 << 18) - 14
)

// EncodeKeycode serializes an INJECT_KEYCODE control message (14 bytes).
func EncodeKeycode(action, keycode, repeat, metastate int) []byte {
	buf := make([]byte, 14)
	buf[0] = CtrlInjectKeycode
	buf[1] = byte(action)
	binary.BigEndian.PutUint32(buf[2:], uint32(keycode))
	binary.BigEndian.PutUint32(buf[6:], uint32(repeat))
	binary.BigEndian.PutUint32(buf[10:], uint32(metastate))
	return buf
}

// EncodeText serializes an INJECT_TEXT control message.
func EncodeText(text string) []byte {
	if len(text) > MaxInjectText {
		text = text[:MaxInjectText]
	}
	buf := make([]byte, 5+len(text))
	buf[0] = CtrlInjectText
	binary.BigEndian.PutUint32(buf[1:], uint32(len(text)))
	copy(buf[5:], text)
	return buf
}

// EncodeTouch serializes an INJECT_TOUCH_EVENT control message (32 bytes).
// pressure is 1.0 for down/move and 0.0 for up.
func EncodeTouch(action int, pointerID uint64, x, y, w, h int, pressure float32, actionButton, buttons int) []byte {
	buf := make([]byte, 32)
	buf[0] = CtrlInjectTouch
	buf[1] = byte(action)
	binary.BigEndian.PutUint64(buf[2:], pointerID)
	binary.BigEndian.PutUint32(buf[10:], uint32(x))
	binary.BigEndian.PutUint32(buf[14:], uint32(y))
	binary.BigEndian.PutUint16(buf[18:], uint16(w))
	binary.BigEndian.PutUint16(buf[20:], uint16(h))
	binary.BigEndian.PutUint16(buf[22:], uint16(pressure*0xFFFF))
	binary.BigEndian.PutUint32(buf[24:], uint32(actionButton))
	binary.BigEndian.PutUint32(buf[28:], uint32(buttons))
	return buf
}

// EncodeScroll serializes an INJECT_SCROLL_EVENT control message (21 bytes).
// hscroll/vscroll are in the range [-16, 16], encoded as i16 fixed point.
func EncodeScroll(x, y, w, h int, hscroll, vscroll float32, buttons int) []byte {
	buf := make([]byte, 21)
	buf[0] = CtrlInjectScroll
	binary.BigEndian.PutUint32(buf[1:], uint32(x))
	binary.BigEndian.PutUint32(buf[5:], uint32(y))
	binary.BigEndian.PutUint16(buf[9:], uint16(w))
	binary.BigEndian.PutUint16(buf[11:], uint16(h))
	binary.BigEndian.PutUint16(buf[13:], uint16(encodeScrollValue(hscroll)))
	binary.BigEndian.PutUint16(buf[15:], uint16(encodeScrollValue(vscroll)))
	binary.BigEndian.PutUint32(buf[17:], uint32(buttons))
	return buf
}

func encodeScrollValue(value float32) int16 {
	if value >= 16 {
		return 0x7fff
	}
	if value <= -16 {
		return -0x8000
	}
	return int16(value / 16 * 0x7fff)
}

// EncodeBackOrScreenOn serializes a BACK_OR_SCREEN_ON message (2 bytes).
func EncodeBackOrScreenOn(action int) []byte {
	return []byte{CtrlBackOrScreenOn, byte(action)}
}

// EncodeExpandNotifications serializes EXPAND_NOTIFICATION_PANEL (1 byte).
func EncodeExpandNotifications() []byte { return []byte{CtrlExpandNotification} }

// EncodeCollapsePanels serializes COLLAPSE_PANELS (1 byte).
func EncodeCollapsePanels() []byte { return []byte{CtrlCollapsePanels} }

// EncodeGetClipboard serializes GET_CLIPBOARD (2 bytes).
func EncodeGetClipboard() []byte { return []byte{CtrlGetClipboard, 1} } // SC_COPY_KEY_COPY

// EncodeSetClipboard serializes SET_CLIPBOARD.
func EncodeSetClipboard(sequence uint64, paste bool, text string) []byte {
	if len(text) > MaxClipboardLen {
		text = text[:MaxClipboardLen]
	}
	buf := make([]byte, 14+len(text))
	buf[0] = CtrlSetClipboard
	binary.BigEndian.PutUint64(buf[1:], sequence)
	if paste {
		buf[9] = 1
	}
	binary.BigEndian.PutUint32(buf[10:], uint32(len(text)))
	copy(buf[14:], text)
	return buf
}

// EncodeSetDisplayPower serializes SET_DISPLAY_POWER (2 bytes).
func EncodeSetDisplayPower(on bool) []byte {
	if on {
		return []byte{CtrlSetDisplayPower, 1}
	}
	return []byte{CtrlSetDisplayPower, 0}
}

// EncodeRotateDevice serializes ROTATE_DEVICE (1 byte).
func EncodeRotateDevice() []byte { return []byte{CtrlRotateDevice} }

// EncodeStartApp serializes START_APP: type, u8 length, app name/package.
func EncodeStartApp(name string) []byte {
	if len(name) > 255 {
		name = name[:255]
	}
	buf := make([]byte, 2+len(name))
	buf[0] = CtrlStartApp
	buf[1] = byte(len(name))
	copy(buf[2:], name)
	return buf
}

// EncodeResetVideo serializes RESET_VIDEO (1 byte): asks the server to
// restart the encoding session (emits a fresh config packet + keyframe).
func EncodeResetVideo() []byte { return []byte{CtrlResetVideo} }

// EncodeResizeDisplay serializes RESIZE_DISPLAY (5 bytes): type, w u16, h u16.
// Only valid on virtual displays created with flex_display=true.
func EncodeResizeDisplay(w, h int) []byte {
	buf := make([]byte, 5)
	buf[0] = CtrlResizeDisplay
	binary.BigEndian.PutUint16(buf[1:], uint16(w))
	binary.BigEndian.PutUint16(buf[3:], uint16(h))
	return buf
}

// EncodeScanFile serializes SCAN_FILE (type, u32 length, path): asks the
// device to media-scan a path (e.g. after a file push).
func EncodeScanFile(path string) []byte {
	if len(path) > 256 {
		path = path[:256]
	}
	buf := make([]byte, 5+len(path))
	buf[0] = CtrlScanFile
	binary.BigEndian.PutUint32(buf[1:], uint32(len(path)))
	copy(buf[5:], path)
	return buf
}

// DeviceMessage is a parsed device -> client message.
type DeviceMessage struct {
	Type     int
	Text     string // clipboard text (DevMsgClipboard)
	Sequence uint64 // ack sequence (DevMsgAckClipboard)
}

// ParseDeviceMessage parses one device message from buf, returning the
// message and the number of consumed bytes (0 if more data is needed).
func ParseDeviceMessage(buf []byte) (DeviceMessage, int, error) {
	var msg DeviceMessage
	if len(buf) < 1 {
		return msg, 0, nil
	}
	msg.Type = int(buf[0])
	switch msg.Type {
	case DevMsgClipboard:
		if len(buf) < 5 {
			return msg, 0, nil
		}
		n := binary.BigEndian.Uint32(buf[1:])
		if n > MaxClipboardLen {
			return msg, 0, fmt.Errorf("clipboard message too large: %d", n)
		}
		if len(buf) < 5+int(n) {
			return msg, 0, nil
		}
		msg.Text = string(buf[5 : 5+n])
		return msg, 5 + int(n), nil
	case DevMsgAckClipboard:
		if len(buf) < 9 {
			return msg, 0, nil
		}
		msg.Sequence = binary.BigEndian.Uint64(buf[1:])
		return msg, 9, nil
	case DevMsgUhidOutput:
		if len(buf) < 5 {
			return msg, 0, nil
		}
		size := int(binary.BigEndian.Uint16(buf[3:]))
		if len(buf) < 5+size {
			return msg, 0, nil
		}
		return msg, 5 + size, nil
	default:
		return msg, 0, fmt.Errorf("unknown device message type: %d", msg.Type)
	}
}
