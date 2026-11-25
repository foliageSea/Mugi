package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

type testTerminal struct {
	net.Conn
	closed  chan struct{}
	resized chan [2]uint16
	once    sync.Once
}

func (t *testTerminal) Resize(rows, cols uint16) error {
	t.resized <- [2]uint16{rows, cols}
	return nil
}
func (t *testTerminal) Close() error {
	t.once.Do(func() { close(t.closed); _ = t.Conn.Close() })
	return nil
}

type developerBackend struct {
	stubBackend
	terminal *testTerminal
}

func (b *developerBackend) Metrics(ctx context.Context, serial string) (string, error) {
	return "__CPU__\ncpu 1 2 3 4\n", nil
}
func (b *developerBackend) OpenTerminal(serial string, rows, cols uint16) (adb.Terminal, error) {
	return b.terminal, nil
}

func TestDeveloperRoutesAccessAndUnsupported(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, mode := range []AccessMode{AccessLocal, AccessExternal} {
		router := NewWithAccessMode(stubBackend{}, scrcpy.NewManager(), mode).Router(http.FS(fstest.MapFS{}))
		for _, path := range []string{"/api/devices/test/metrics", "/ws/devices/test/terminal"} {
			res := httptest.NewRecorder()
			router.ServeHTTP(res, localRequest("GET", path, nil))
			want := http.StatusNotImplemented
			if mode == AccessExternal {
				want = http.StatusForbidden
			}
			if res.Code != want {
				t.Fatalf("%s: got %d want %d", path, res.Code, want)
			}
		}
	}
}

func TestTerminalRelayResizeAndCleanup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client, device := net.Pipe()
	defer device.Close()
	terminal := &testTerminal{Conn: client, closed: make(chan struct{}), resized: make(chan [2]uint16, 1)}
	backend := &developerBackend{terminal: terminal}
	s := New(backend, scrcpy.NewManager())
	server := httptest.NewServer(s.Router(http.FS(fstest.MapFS{})))
	defer server.Close()
	response, err := http.Get(server.URL + "/api/devices/test/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "__CPU__") || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("metrics response: %d %s", response.StatusCode, body)
	}
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/devices/test/terminal"
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, ready, err := ws.ReadMessage()
	if err != nil || !strings.Contains(string(ready), "ready") {
		t.Fatalf("ready: %s %v", ready, err)
	}
	res := httptest.NewRecorder()
	s.Router(http.FS(fstest.MapFS{})).ServeHTTP(res, localRequest("POST", "/api/adb/release", nil))
	if res.Code != http.StatusConflict {
		t.Fatalf("release during terminal: %d", res.Code)
	}
	if err := ws.WriteJSON(gin.H{"type": "resize", "rows": 40, "cols": 120}); err != nil {
		t.Fatal(err)
	}
	select {
	case size := <-terminal.resized:
		if size != [2]uint16{40, 120} {
			t.Fatal(size)
		}
	case <-time.After(time.Second):
		t.Fatal("resize not forwarded")
	}
	go func() { _, _ = io.Copy(device, device) }()
	if err := ws.WriteJSON(gin.H{"type": "input", "data": "你好\x03"}); err != nil {
		t.Fatal(err)
	}
	kind, data, err := ws.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || string(data) != "你好\x03" {
		t.Fatalf("output: %q %v", data, err)
	}
	// Disconnect without acknowledging output: cleanup must not wait for the ack timeout.
	_ = ws.Close()
	select {
	case <-terminal.closed:
	case <-time.After(time.Second):
		t.Fatal("shell leaked")
	}
}

func TestTerminalRejectsCrossOriginBeforeOpeningShell(t *testing.T) {
	s := New(&developerBackend{}, scrcpy.NewManager())
	server := httptest.NewServer(s.Router(http.FS(fstest.MapFS{})))
	defer server.Close()
	header := http.Header{"Origin": []string{"https://other.example"}}
	_, res, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/devices/test/terminal", header)
	if err == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("origin: %v %v", res, err)
	}
}
