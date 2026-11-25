package scrcpy

import (
	"bytes"
	"testing"
)

func TestStreamRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteSessionPacket(&buf, 1080, 2400, false); err != nil {
		t.Fatal(err)
	}
	if err := WriteMediaPacket(&buf, 123456, true, true, []byte{0x00, 0x00, 0x00, 0x01, 0x67}); err != nil {
		t.Fatal(err)
	}
	if err := WriteMediaPacket(&buf, 123489, false, false, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	p := NewPacketParser(true)
	data := buf.Bytes()

	hdr := data[:12]
	isSession, _, _, _, _ := p.ParseHeader(hdr)
	if !isSession {
		t.Fatal("expected session packet")
	}
	sp := ParseSession(hdr)
	if sp.Width != 1080 || sp.Height != 2400 || sp.ClientResized {
		t.Fatalf("bad session packet: %+v", sp)
	}

	rest := data[12:]
	isSession, pts, config, key, size := p.ParseHeader(rest[:12])
	if isSession || !config || !key || pts != 123456 || size != 5 {
		t.Fatalf("bad media header: session=%v pts=%d config=%v key=%v size=%d", isSession, pts, config, key, size)
	}

	rest = rest[12+5:]
	isSession, pts, config, key, size = p.ParseHeader(rest[:12])
	if isSession || config || key || pts != 123489 || size != 3 {
		t.Fatalf("bad media header 2: session=%v pts=%d config=%v key=%v size=%d", isSession, pts, config, key, size)
	}
}

func TestCodecName(t *testing.T) {
	if CodecName(CodecH264) != "h264" {
		t.Fatal("h264")
	}
	if CodecName(CodecOpus) != "opus" {
		t.Fatal("opus")
	}
}
