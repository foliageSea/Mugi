package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
	"mugi/internal/scrcpy"
)

type testLogcatBackend struct {
	stubBackend
	stream  io.ReadCloser
	cleared string
}

func (b *testLogcatBackend) OpenLogcat(context.Context, string) (io.ReadCloser, error) {
	return b.stream, nil
}
func (b *testLogcatBackend) ClearLogcat(_ context.Context, serial string) error {
	b.cleared = serial
	return nil
}
func (b *testLogcatBackend) LogcatProcesses(context.Context, string) (string, error) {
	return "PID NAME\n123 com.example.app\n", nil
}

func TestLogcatAccessAndUnsupported(t *testing.T) {
	for _, mode := range []AccessMode{AccessLocal, AccessExternal} {
		router := NewWithAccessMode(stubBackend{}, scrcpy.NewManager(), mode).Router(http.FS(fstest.MapFS{}))
		for _, req := range [][2]string{
			{"GET", "/ws/devices/test/logcat"},
			{"GET", "/api/devices/test/logcat/processes"},
			{"DELETE", "/api/devices/test/logcat"},
		} {
			res := httptest.NewRecorder()
			router.ServeHTTP(res, localRequest(req[0], req[1], nil))
			want := http.StatusNotImplemented
			if mode == AccessExternal {
				want = http.StatusForbidden
			}
			if res.Code != want {
				t.Fatalf("%v: got %d want %d", req, res.Code, want)
			}
		}
	}
}

func TestLogcatRelayAndCleanup(t *testing.T) {
	for _, sendOutput := range []bool{false, true} {
		t.Run(map[bool]string{false: "silent", true: "awaiting-ack"}[sendOutput], func(t *testing.T) {
			client, device := net.Pipe()
			defer device.Close()
			stream := &testTerminal{Conn: client, closed: make(chan struct{})}
			backend := &testLogcatBackend{stream: stream}
			s := New(backend, scrcpy.NewManager())
			router := s.Router(http.FS(fstest.MapFS{}))
			server := httptest.NewServer(router)
			defer server.Close()
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/devices/test/logcat", nil)
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
			router.ServeHTTP(res, localRequest("POST", "/api/adb/release", nil))
			if res.Code != http.StatusConflict {
				t.Fatalf("release while streaming: %d", res.Code)
			}
			res = httptest.NewRecorder()
			router.ServeHTTP(res, localRequest("DELETE", "/api/devices/test/logcat", nil))
			if res.Code != http.StatusOK || backend.cleared != "test" {
				t.Fatalf("clear: %d %s", res.Code, res.Body)
			}
			res = httptest.NewRecorder()
			router.ServeHTTP(res, localRequest("GET", "/api/devices/test/logcat/processes", nil))
			if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "com.example.app") {
				t.Fatalf("processes: %d %s", res.Code, res.Body)
			}
			if sendOutput {
				go func() { _, _ = device.Write([]byte("日志\n")) }()
				kind, data, err := ws.ReadMessage()
				if err != nil || kind != websocket.BinaryMessage || string(data) != "日志\n" {
					t.Fatalf("output: %q %v", data, err)
				}
			}
			_ = ws.Close()
			select {
			case <-stream.closed:
			case <-time.After(time.Second):
				t.Fatal("Logcat stream leaked")
			}
			deadline := time.Now().Add(time.Second)
			for {
				s.adbMu.RLock()
				active := s.logcats
				s.adbMu.RUnlock()
				if active == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("active Logcat count leaked")
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}

func TestLogcatRejectsCrossOriginBeforeOpeningProcess(t *testing.T) {
	s := New(&testLogcatBackend{}, scrcpy.NewManager())
	server := httptest.NewServer(s.Router(http.FS(fstest.MapFS{})))
	defer server.Close()
	_, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/devices/test/logcat", http.Header{"Origin": []string{"https://other.example"}})
	if err == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("origin: %v %v", response, err)
	}
}
