// Channel pumps own the read side of a session's scrcpy sockets, independent
// of any attached WebSocket consumer. A consumer may detach (tab hidden,
// network hiccup, page reload) and re-attach to the same session; the device
// stream keeps flowing meanwhile. Video delivery applies frame-level
// backpressure: when a consumer falls behind, delta packets are dropped until
// the next keyframe instead of letting latency accumulate in TCP/WS buffers.
package server

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"mugi/internal/scrcpy"
)

const (
	// videoQueueDepth bounds how many video packets a slow consumer may buffer
	// before the pump starts dropping delta frames (~0.4s at 60fps).
	videoQueueDepth   = 24
	audioQueueDepth   = 64
	controlQueueDepth = 32
	rawChunkSize      = 32 << 10
	packetHeaderLen   = 12
	// maxPacketSize guards against a corrupt size field allocating unbounded
	// memory; keyframes at the 50 Mbit/s bitrate ceiling stay far below this.
	maxPacketSize = 64 << 20
	// sessionIdleTimeout is how long a fully detached session survives for
	// re-attach (e.g. across a page reload) before it is torn down.
	sessionIdleTimeout    = 90 * time.Second
	videoRecoveryInterval = time.Second
	videoRecoveryTimeout  = 15 * time.Second
)

// channelPump reads one scrcpy channel socket and fans out to at most one
// subscriber queue. A nil subscriber means the data is parsed and discarded,
// which keeps device-side TCP buffers draining while nobody is attached.
type channelPump struct {
	conn                net.Conn
	prefix              []byte // replayed to every new subscriber (stream handshake)
	video               bool
	depth               int
	dropping            bool // guarded by mu; only the read loop transitions it
	requestKeyFrame     func() error
	recoveryWake        chan struct{}
	recoveryStarted     time.Time // guarded by mu
	lastRecoveryRequest time.Time // guarded by mu

	mu       sync.Mutex
	sub      chan []byte
	attached bool // becomes true on first attach; re-attaches need a keyframe
	dead     bool
}

func newChannelPump(conn net.Conn, prefix []byte, depth int, video bool) *channelPump {
	return &channelPump{conn: conn, prefix: prefix, depth: depth, video: video, recoveryWake: make(chan struct{}, 1)}
}

// attach subscribes a consumer. It returns the subscription queue and whether
// this is a re-attach (the consumer missed earlier stream state and, for
// video, needs a fresh config packet + keyframe). A new attach evicts any
// previous subscriber. ErrChannelDead reports a finished device stream.
var ErrChannelDead = errors.New("channel closed")

func (p *channelPump) attach() (sub chan []byte, reattached bool, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dead {
		return nil, false, ErrChannelDead
	}
	reattached = p.attached
	if p.sub != nil {
		close(p.sub)
	}
	p.sub = make(chan []byte, p.depth)
	p.attached = true
	p.dropping = false
	p.recoveryStarted = time.Time{}
	return p.sub, reattached, nil
}

// detach removes the subscription previously returned by attach.
func (p *channelPump) detach(sub chan []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sub == sub {
		p.sub = nil
	}
}

// deliver offers data to the subscriber. droppable data is discarded when the
// queue is full (and the call reports not-delivered); data that must arrive
// evicts the oldest queued item. Data with no subscriber counts as delivered.
func (p *channelPump) deliver(data []byte, droppable bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sub == nil {
		return true
	}
	select {
	case p.sub <- data:
		return true
	default:
	}
	if droppable {
		return false
	}
	select {
	case <-p.sub:
	default:
	}
	select {
	case p.sub <- data:
	default:
	}
	return true
}

// run reads the channel until it fails, then marks the pump dead, releases
// the subscriber and invokes onDead.
func (p *channelPump) run(onDead func()) {
	if p.video && p.requestKeyFrame != nil {
		done := make(chan struct{})
		defer close(done)
		go p.recoverVideo(done)
	}
	if p.video {
		_ = p.runVideo()
	} else {
		_ = p.runRaw()
	}
	p.mu.Lock()
	p.dead = true
	sub := p.sub
	p.sub = nil
	p.mu.Unlock()
	if sub != nil {
		close(sub)
	}
	onDead()
}

// runVideo relays whole packets so slow consumers can drop delta frames on
// packet boundaries; a resumed stream always restarts at a keyframe.
func (p *channelPump) runVideo() error {
	parser := scrcpy.NewPacketParser(true)
	hdr := make([]byte, packetHeaderLen)
	for {
		if _, err := io.ReadFull(p.conn, hdr); err != nil {
			return err
		}
		isSession, _, config, key, size := parser.ParseHeader(hdr)
		var pkt []byte
		if isSession {
			pkt = append([]byte(nil), hdr...)
		} else {
			if size > maxPacketSize {
				return fmt.Errorf("video packet too large: %d", size)
			}
			pkt = make([]byte, packetHeaderLen+size)
			copy(pkt, hdr)
			if _, err := io.ReadFull(p.conn, pkt[packetHeaderLen:]); err != nil {
				return err
			}
		}
		if isSession {
			p.deliver(pkt, false)
			continue
		}
		droppable := !key && !config
		p.mu.Lock()
		dropping := p.dropping
		p.mu.Unlock()
		if dropping && droppable {
			continue
		}
		if key {
			p.setDropping(false)
		}
		if !p.deliver(pkt, droppable) {
			p.setDropping(true)
		}
	}
}

func (p *channelPump) setDropping(value bool) {
	p.mu.Lock()
	started := value && !p.dropping
	if started {
		p.recoveryStarted = time.Now()
	} else if !value {
		p.recoveryStarted = time.Time{}
	}
	p.dropping = value
	p.mu.Unlock()
	if started {
		select {
		case p.recoveryWake <- struct{}{}:
		default:
		}
	}
}

// Recovery runs independently of packet reads, including when the encoder
// stops sending after a dropped frame. Never block the video pump on control I/O.
func (p *channelPump) recoverVideo(done <-chan struct{}) {
	ticker := time.NewTicker(videoRecoveryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-p.recoveryWake:
		case <-ticker.C:
		}
		if err := p.requestRecovery(time.Now()); err != nil {
			log.Printf("video recovery failed: %v", err)
			_ = p.conn.Close()
			return
		}
	}
}

func (p *channelPump) requestRecovery(now time.Time) error {
	p.mu.Lock()
	if p.dead || p.sub == nil || !p.dropping || p.requestKeyFrame == nil {
		p.mu.Unlock()
		return nil
	}
	if now.Sub(p.recoveryStarted) >= videoRecoveryTimeout {
		p.mu.Unlock()
		return fmt.Errorf("timed out waiting for video keyframe")
	}
	if !p.lastRecoveryRequest.IsZero() && now.Sub(p.lastRecoveryRequest) < videoRecoveryInterval {
		p.mu.Unlock()
		return nil
	}
	p.lastRecoveryRequest = now
	p.mu.Unlock()
	return p.requestKeyFrame()
}

// runRaw relays opaque chunks (audio/control). On backlog the oldest queued
// data is evicted: every audio packet is independently decodable, and only
// the latest clipboard/control state matters.
func (p *channelPump) runRaw() error {
	buf := make([]byte, rawChunkSize)
	for {
		n, err := p.conn.Read(buf)
		if n > 0 {
			p.deliver(append([]byte(nil), buf[:n]...), false)
		}
		if err != nil {
			return err
		}
	}
}

// sessionHub groups a session's channel pumps and tracks how many WebSocket
// consumers are attached, so a fully detached session can expire.
type sessionHub struct {
	server  *Server
	session *scrcpy.Session
	pumps   map[string]*channelPump

	mu        sync.Mutex
	subs      int
	idleTimer *time.Timer
}

func (h *sessionHub) attached() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs++
	if h.idleTimer != nil {
		h.idleTimer.Stop()
		h.idleTimer = nil
	}
}

func (h *sessionHub) detached() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs--
	if h.subs > 0 || h.idleTimer != nil {
		return
	}
	h.idleTimer = time.AfterFunc(sessionIdleTimeout, func() {
		h.server.expireSession(h.session.ID)
	})
}

// hubFor returns the session's hub, creating pumps on first use. The pumps
// become the sole readers of the session's sockets.
func (s *Server) hubFor(sess *scrcpy.Session) *sessionHub {
	s.hubsMu.Lock()
	defer s.hubsMu.Unlock()
	if hub, ok := s.hubs[sess.ID]; ok {
		return hub
	}
	hub := &sessionHub{server: s, session: sess, pumps: map[string]*channelPump{}}
	vprefix, vconn := sess.Video()
	hub.pumps["video"] = newChannelPump(vconn, vprefix, videoQueueDepth, true)
	hub.pumps["video"].requestKeyFrame = func() error {
		return sess.SendControl(scrcpy.EncodeResetVideo())
	}
	if aprefix, aconn := sess.Audio(); aconn != nil {
		hub.pumps["audio"] = newChannelPump(aconn, aprefix, audioQueueDepth, false)
	}
	hub.pumps["control"] = newChannelPump(sess.Control(), nil, controlQueueDepth, false)
	s.hubs[sess.ID] = hub
	for channel, pump := range hub.pumps {
		go pump.run(func() { s.pumpDied(sess.ID, channel) })
	}
	return hub
}

// pumpDied handles a finished device stream. Audio is optional and dies
// quietly; video or control ending means the session is over.
func (s *Server) pumpDied(id, channel string) {
	if channel == "audio" {
		return
	}
	if sess := s.manager.Get(id); sess != nil {
		sess.Close()
		s.manager.Remove(id)
	}
	s.dropHub(id)
}

// expireSession tears down a session whose idle timer fired, unless a
// consumer re-attached in the meantime.
func (s *Server) expireSession(id string) {
	s.hubsMu.Lock()
	hub, ok := s.hubs[id]
	s.hubsMu.Unlock()
	if ok {
		hub.mu.Lock()
		idle := hub.subs == 0
		hub.mu.Unlock()
		if !idle {
			return
		}
	}
	if sess := s.manager.Get(id); sess != nil {
		sess.Close()
		s.manager.Remove(id)
	}
	s.dropHub(id)
}

func (s *Server) dropHub(id string) {
	s.hubsMu.Lock()
	hub := s.hubs[id]
	delete(s.hubs, id)
	s.hubsMu.Unlock()
	if hub != nil {
		hub.mu.Lock()
		if hub.idleTimer != nil {
			hub.idleTimer.Stop()
			hub.idleTimer = nil
		}
		hub.mu.Unlock()
	}
}
