package server

import (
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mugi/internal/scrcpy"
)

// writePacket emits one media packet on w.
func writePacket(t *testing.T, w net.Conn, pts uint64, config, key bool, payload []byte) {
	t.Helper()
	if err := scrcpy.WriteMediaPacket(w, pts, config, key, payload); err != nil {
		t.Fatalf("write packet: %v", err)
	}
}

// packetFlags extracts the key/config flags of a relayed video packet.
func packetFlags(pkt []byte) (key, config bool) {
	v := binary.BigEndian.Uint64(pkt)
	return v&(1<<61) != 0, v&(1<<62) != 0
}

func TestVideoPumpDropsDeltaFramesForSlowConsumer(t *testing.T) {
	client, server := net.Pipe()
	pump := newChannelPump(server, nil, videoQueueDepth, true)
	dead := make(chan struct{})
	go pump.run(func() { close(dead) })

	sub, reattached, err := pump.attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if reattached {
		t.Fatal("first attach must not report reattach")
	}

	// Never read from sub: the consumer is stalled. The pump must keep
	// reading (net.Pipe would otherwise block the writer) and drop deltas.
	writePacket(t, client, 1, false, true, []byte{0x65}) // initial keyframe
	for i := 0; i < 4*videoQueueDepth; i++ {
		writePacket(t, client, uint64(10+i), false, false, []byte{0x41})
	}
	writePacket(t, client, 1000, false, true, []byte{0x65}) // recovery keyframe

	// net.Pipe unblocks the writer when the pump reads, which can beat the
	// delivery by a scheduling quantum. Drain until the recovery keyframe
	// shows up instead of assuming a fixed queue snapshot.
	timeout := time.After(2 * time.Second)
	deltas, recovered := 0, false
	for !recovered {
		select {
		case pkt := <-sub:
			key, _ := packetFlags(pkt)
			if key && binary.BigEndian.Uint64(pkt)&^(0x7<<61) == 1000 {
				recovered = true
			} else if !key {
				deltas++
			}
		case <-timeout:
			t.Fatal("recovery keyframe must be delivered even to a stalled consumer")
		}
	}
	if deltas > videoQueueDepth {
		t.Fatalf("stalled consumer received %d deltas, queue depth is %d", deltas, videoQueueDepth)
	}

	_ = client.Close()
	select {
	case <-dead:
	case <-time.After(2 * time.Second):
		t.Fatal("pump did not stop after conn close")
	}
	if _, _, err := pump.attach(); err == nil {
		t.Fatal("attach on a dead pump must fail")
	}
}

func TestVideoPumpKeepsUpWithFastConsumer(t *testing.T) {
	client, server := net.Pipe()
	pump := newChannelPump(server, nil, videoQueueDepth, true)
	go pump.run(func() {})

	sub, _, err := pump.attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}

	const total = 200
	var wg sync.WaitGroup
	wg.Add(1)
	var received atomic.Int32
	go func() {
		defer wg.Done()
		for range sub {
			received.Add(1)
		}
	}()
	for i := 0; i < total; i++ {
		writePacket(t, client, uint64(i), false, i%50 == 0, []byte{byte(i)})
	}
	// Drain everything, then close and check nothing was dropped.
	deadline := time.Now().Add(2 * time.Second)
	for int(received.Load()) < total && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if int(received.Load()) != total {
		t.Fatalf("fast consumer lost packets: got %d of %d", received.Load(), total)
	}
	_ = client.Close()
	wg.Wait()
}

func TestRawPumpEvictsOldestForSlowConsumer(t *testing.T) {
	client, server := net.Pipe()
	pump := newChannelPump(server, nil, controlQueueDepth, false)
	go pump.run(func() {})

	sub, _, err := pump.attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}

	// Fill the queue without reading, then overflow it. net.Pipe unblocks the
	// writer when the pump reads, so let the pump settle before inspecting.
	overflow := controlQueueDepth * 2
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < overflow; i++ {
			if _, err := client.Write([]byte{byte(i)}); err != nil {
				return
			}
		}
	}()
	<-done
	deadline := time.Now().Add(2 * time.Second)
	for len(sub) < controlQueueDepth && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)

	first := <-sub
	if int(first[0]) != overflow-controlQueueDepth {
		t.Fatalf("oldest data was not evicted: first byte = %d, want %d",
			first[0], overflow-controlQueueDepth)
	}
	_ = client.Close()
}

func TestPumpReattachEvictsPreviousSubscriber(t *testing.T) {
	client, server := net.Pipe()
	pump := newChannelPump(server, nil, controlQueueDepth, false)
	go pump.run(func() {})

	first, _, err := pump.attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	second, reattached, err := pump.attach()
	if err != nil {
		t.Fatalf("re-attach: %v", err)
	}
	if !reattached {
		t.Fatal("second attach must report reattach")
	}
	if _, ok := <-first; ok {
		t.Fatal("evicted subscriber queue must be closed")
	}
	pump.detach(second)
	_ = client.Close()
}

func TestVideoRecoveryRequestsAreRateLimited(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	pump := newChannelPump(server, nil, 1, true)
	requests := 0
	pump.requestKeyFrame = func() error { requests++; return nil }
	sub, _, err := pump.attach()
	if err != nil {
		t.Fatal(err)
	}
	pump.setDropping(true)
	now := time.Now()
	for i := 0; i < 100; i++ {
		if err := pump.requestRecovery(now); err != nil {
			t.Fatal(err)
		}
	}
	if requests != 1 {
		t.Fatalf("expected one immediate request, got %d", requests)
	}
	if err := pump.requestRecovery(now.Add(videoRecoveryInterval)); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("expected a retry after the cooldown, got %d", requests)
	}
	pump.setDropping(false)
	if err := pump.requestRecovery(now.Add(2 * videoRecoveryInterval)); err != nil {
		t.Fatal(err)
	}
	pump.setDropping(true)
	pump.detach(sub)
	if err := pump.requestRecovery(now.Add(3 * videoRecoveryInterval)); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatal("recovered or detached consumers must not request keyframes")
	}
}

func TestVideoRecoveryTimeout(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	pump := newChannelPump(server, nil, 1, true)
	pump.requestKeyFrame = func() error { return nil }
	if _, _, err := pump.attach(); err != nil {
		t.Fatal(err)
	}
	pump.setDropping(true)
	if err := pump.requestRecovery(time.Now().Add(videoRecoveryTimeout)); err == nil {
		t.Fatal("missing keyframe must time out")
	}
	// A reattach begins a fresh recovery window, not the expired one.
	if _, _, err := pump.attach(); err != nil {
		t.Fatal(err)
	}
	pump.setDropping(true)
	if err := pump.requestRecovery(time.Now()); err != nil {
		t.Fatalf("reattached consumer inherited an old timeout: %v", err)
	}
}

func TestVideoRecoveryRetriesWithoutIncomingPackets(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	pump := newChannelPump(server, nil, 1, true)
	requests := make(chan struct{}, 3)
	pump.requestKeyFrame = func() error { requests <- struct{}{}; return nil }
	if _, _, err := pump.attach(); err != nil {
		t.Fatal(err)
	}
	dead := make(chan struct{})
	go pump.run(func() { close(dead) })
	writePacket(t, client, 0, false, true, []byte{0x65})
	writePacket(t, client, 1, false, false, []byte{0x41}) // overflow
	for i := 0; i < 2; i++ {
		select {
		case <-requests:
		case <-time.After(3 * time.Second):
			t.Fatal("recovery must request and retry without more video packets")
		}
	}
	_ = client.Close()
	select {
	case <-dead:
	case <-time.After(time.Second):
		t.Fatal("recovery must not prevent pump shutdown")
	}
}

func TestVideoRecoveryFailureClosesPump(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	pump := newChannelPump(server, nil, 1, true)
	pump.requestKeyFrame = func() error { return errors.New("control channel unavailable") }
	if _, _, err := pump.attach(); err != nil {
		t.Fatal(err)
	}
	dead := make(chan struct{})
	go pump.run(func() { close(dead) })
	pump.setDropping(true)
	select {
	case <-dead:
	case <-time.After(time.Second):
		t.Fatal("failed recovery must close the pump instead of leaving it frozen")
	}
}

func TestVideoRecoveryTimeoutClosesPump(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	pump := newChannelPump(server, nil, 1, true)
	pump.requestKeyFrame = func() error { return nil }
	if _, _, err := pump.attach(); err != nil {
		t.Fatal(err)
	}
	pump.setDropping(true)
	pump.mu.Lock()
	pump.recoveryStarted = time.Now().Add(-videoRecoveryTimeout)
	pump.mu.Unlock()
	dead := make(chan struct{})
	go pump.run(func() { close(dead) })
	select {
	case <-dead:
	case <-time.After(time.Second):
		t.Fatal("expired recovery must close even when the video socket is silent")
	}
}
