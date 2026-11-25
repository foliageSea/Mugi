package scrcpy

import (
	"bytes"
	"testing"
)

// Golden vectors from Genymobile/scrcpy app/tests/test_control_msg_serialize.c.

func TestEncodeKeycode(t *testing.T) {
	got := EncodeKeycode(ActionUp, 0x42, 5, 0x41)
	want := []byte{
		CtrlInjectKeycode,
		0x01,
		0x00, 0x00, 0x00, 0x42,
		0x00, 0x00, 0x00, 0x05,
		0x00, 0x00, 0x00, 0x41,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeText(t *testing.T) {
	got := EncodeText("hello, world!")
	want := append([]byte{CtrlInjectText, 0x00, 0x00, 0x00, 0x0d}, []byte("hello, world!")...)
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeTouch(t *testing.T) {
	got := EncodeTouch(0, 0x1234567887654321, 100, 200, 1080, 1920, 1.0, ButtonPrimary, ButtonPrimary)
	want := []byte{
		CtrlInjectTouch,
		0x00,
		0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21,
		0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8,
		0x04, 0x38, 0x07, 0x80,
		0xff, 0xff,
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x01,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeScroll(t *testing.T) {
	got := EncodeScroll(260, 1026, 1080, 1920, 16, -16, 1)
	want := []byte{
		CtrlInjectScroll,
		0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x04, 0x02,
		0x04, 0x38, 0x07, 0x80,
		0x7F, 0xFF,
		0x80, 0x00,
		0x00, 0x00, 0x00, 0x01,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeSetClipboard(t *testing.T) {
	got := EncodeSetClipboard(0x0102030405060708, true, "hello, world!")
	want := append([]byte{
		CtrlSetClipboard,
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		1,
		0x00, 0x00, 0x00, 0x0d,
	}, []byte("hello, world!")...)
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeSetDisplayPower(t *testing.T) {
	if got := EncodeSetDisplayPower(false); !bytes.Equal(got, []byte{CtrlSetDisplayPower, 0}) {
		t.Fatalf("off: got %v", got)
	}
	if got := EncodeSetDisplayPower(true); !bytes.Equal(got, []byte{CtrlSetDisplayPower, 1}) {
		t.Fatalf("on: got %v", got)
	}
}

func TestEncodeBackOrScreenOn(t *testing.T) {
	if got := EncodeBackOrScreenOn(ActionDown); !bytes.Equal(got, []byte{CtrlBackOrScreenOn, ActionDown}) {
		t.Fatalf("got %v", got)
	}
}

func TestEncodeStartApp(t *testing.T) {
	got := EncodeStartApp("firefox")
	want := append([]byte{CtrlStartApp, 7}, []byte("firefox")...)
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeResizeDisplay(t *testing.T) {
	got := EncodeResizeDisplay(1920, 1080)
	want := []byte{CtrlResizeDisplay, 1920 >> 8, 1920 & 0xff, 1080 >> 8, 1080 & 0xff}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseDeviceClipboard(t *testing.T) {
	input := append([]byte{DevMsgClipboard, 0x00, 0x00, 0x00, 0x03}, []byte("ABC")...)
	msg, n, err := ParseDeviceMessage(input)
	if err != nil {
		t.Fatal(err)
	}
	if n != 8 || msg.Type != DevMsgClipboard || msg.Text != "ABC" {
		t.Fatalf("got %+v n=%d", msg, n)
	}
}

func TestParseDeviceAckClipboard(t *testing.T) {
	input := []byte{DevMsgAckClipboard, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08}
	msg, n, err := ParseDeviceMessage(input)
	if err != nil {
		t.Fatal(err)
	}
	if n != 9 || msg.Type != DevMsgAckClipboard || msg.Sequence != 0x0102030405060708 {
		t.Fatalf("got %+v n=%d", msg, n)
	}
}

func TestParseDeviceMessagePartial(t *testing.T) {
	input := []byte{DevMsgClipboard, 0x00, 0x00}
	_, n, err := ParseDeviceMessage(input)
	if err != nil || n != 0 {
		t.Fatalf("partial parse: n=%d err=%v", n, err)
	}
}
