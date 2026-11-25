package scrcpy

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"
)

// Stream framing on the video/audio sockets (scrcpy v4 protocol):
//
//   - video socket: [dummy byte (forward tunnel)] [device name (64 bytes)]
//     [codec id (u32be)] then a sequence of packets.
//   - audio socket: [codec id (u32be)] then a sequence of packets.
//
// A packet is either a session packet (video only, MSB of byte0 set) or a
// media packet with a 12-byte header:
//
//	byte0: media flag (0) | config flag (bit6) | key flag (bit5) | PTS high bits
//	bytes 0..7: PTS (61 bits, big endian, top 3 bits are flags)
//	bytes 8..11: packet size (u32be)
//	then the raw payload produced by MediaCodec.

// Codec ids.
const (
	CodecH264 = 0x68323634 // "h264"
	CodecH265 = 0x68323635 // "h265"
	CodecAV1  = 0x00617631 // "av1"
	CodecOpus = 0x6F707573 // "opus"
	CodecAAC  = 0x00616163 // "aac"
	CodecFLAC = 0x666C6163 // "flac"
	CodecRaw  = 0x00726177 // "raw"
)

const (
	deviceNameLen = 64
	headerLen     = 12
	ptsFlagConfig = uint64(1) << 62
	ptsFlagKey    = uint64(1) << 61
	ptsMask       = ^(uint64(0x7) << 61)
)

// MediaPacket is one parsed media packet.
type MediaPacket struct {
	PTS     uint64
	Config  bool
	Key     bool
	Payload []byte
}

// SessionPacket carries the video dimensions (sent on each capture session).
type SessionPacket struct {
	Width         int
	Height        int
	ClientResized bool
}

// CodecName converts a codec id to its 4-char name.
func CodecName(id uint32) string {
	return strings.TrimLeft(string([]byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)}), "\x00")
}

// WriteSessionPacket encodes a session packet.
func WriteSessionPacket(w io.Writer, width, height int, clientResized bool) error {
	var buf [headerLen]byte
	buf[0] = 0x80 // session packet flag (MSB)
	if clientResized {
		buf[3] = 1
	}
	binary.BigEndian.PutUint32(buf[4:], uint32(width))
	binary.BigEndian.PutUint32(buf[8:], uint32(height))
	_, err := w.Write(buf[:])
	return err
}

// WriteMediaPacket encodes a media packet with its 12-byte header.
func WriteMediaPacket(w io.Writer, pts uint64, config, key bool, payload []byte) error {
	var buf [headerLen]byte
	v := pts & ptsMask
	if config {
		v |= ptsFlagConfig
	}
	if key {
		v |= ptsFlagKey
	}
	binary.BigEndian.PutUint64(buf[:], v)
	binary.BigEndian.PutUint32(buf[8:], uint32(len(payload)))
	if _, err := w.Write(buf[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// PacketParser incrementally parses session/media packets from a stream.
type PacketParser struct {
	isVideo bool
}

// NewPacketParser creates a parser; isVideo enables session packet handling.
func NewPacketParser(isVideo bool) *PacketParser { return &PacketParser{isVideo: isVideo} }

// ParseHeader parses a 12-byte packet header. It returns isSession,
// (for media packets) pts/config/key/size, or (for session packets)
// width/height in the size field via ParseSession.
func (p *PacketParser) ParseHeader(hdr []byte) (isSession bool, pts uint64, config, key bool, size uint32) {
	if len(hdr) < headerLen {
		panic("short header")
	}
	if hdr[0]&0x80 != 0 {
		return true, 0, false, false, 0
	}
	v := binary.BigEndian.Uint64(hdr)
	return false, v & ptsMask, v&ptsFlagConfig != 0, v&ptsFlagKey != 0, binary.BigEndian.Uint32(hdr[8:])
}

// ParseSession parses a session packet's width/height.
func ParseSession(pkt []byte) SessionPacket {
	if len(pkt) < headerLen {
		panic("short session packet")
	}
	return SessionPacket{
		Width:         int(binary.BigEndian.Uint32(pkt[4:])),
		Height:        int(binary.BigEndian.Uint32(pkt[8:])),
		ClientResized: pkt[3]&1 != 0,
	}
}

// ReadDeviceMeta reads the dummy byte and the 64-byte device name sent on the
// first socket of a forward tunnel.
func ReadDeviceMeta(r io.Reader) (string, error) {
	var dummy [1]byte
	if _, err := io.ReadFull(r, dummy[:]); err != nil {
		return "", fmt.Errorf("read dummy byte: %w", err)
	}
	name := make([]byte, deviceNameLen)
	if _, err := io.ReadFull(r, name); err != nil {
		return "", fmt.Errorf("read device name: %w", err)
	}
	// The name is zero-padded.
	end := len(name)
	for i, b := range name {
		if b == 0 {
			end = i
			break
		}
	}
	return string(name[:end]), nil
}

// ReadCodecID reads the 4-byte codec id at the start of a video/audio socket.
func ReadCodecID(r io.Reader) (uint32, error) {
	var buf [4]byte
	if _, err := io.ReadFull(r, buf[:]); err != nil {
		return 0, fmt.Errorf("read codec id: %w", err)
	}
	return binary.BigEndian.Uint32(buf[:]), nil
}
