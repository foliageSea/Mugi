package desktop

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

func TestBridgeAuthenticatesAndClosesWebSockets(t *testing.T) {
	requests := make(chan string, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{} // The ordinary same-origin policy still applies.
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		requests <- r.URL.RequestURI()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, data) != nil {
				return
			}
		}
	})
	bridge, err := NewBridge(handler)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	if !strings.HasPrefix(bridge.WebSocketBase, "ws://127.0.0.1:") {
		t.Fatalf("not loopback: %s", bridge.WebSocketBase)
	}

	for _, tc := range []struct{ path, origin string }{
		{"/ws/test", ""},
		{"/ws/test", "https://evil.example"},
		{"/api/devices", Origin},
		{"/", Origin},
		{"/invalid/ws/test", Origin},
	} {
		ws, response, err := websocket.DefaultDialer.Dial(bridge.WebSocketBase+tc.path, http.Header{"Origin": {tc.origin}})
		if ws != nil {
			ws.Close()
			t.Fatalf("unexpected accepted request: %+v", tc)
		}
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatalf("expected forbidden for %+v, response=%v err=%v", tc, response, err)
		}
		response.Body.Close()
	}
	// A correct origin without the unguessable prefix is also rejected.
	address := bridge.WebSocketBase[:strings.LastIndex(bridge.WebSocketBase, "/")]
	_, response, err := websocket.DefaultDialer.Dial(address+"/ws/test", http.Header{"Origin": {Origin}})
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing token accepted: %v", err)
	}
	response.Body.Close()

	ws, _, err := websocket.DefaultDialer.Dial(bridge.WebSocketBase+"/ws/test?rows=24", http.Header{"Origin": {Origin}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if got := <-requests; got != "/ws/test?rows=24" {
		t.Fatalf("path/query was not preserved: %s", got)
	}
	if err := ws.WriteMessage(websocket.BinaryMessage, []byte{0, 1, 255}); err != nil {
		t.Fatal(err)
	}
	_, data, err := ws.ReadMessage()
	if err != nil || string(data) != string([]byte{0, 1, 255}) {
		t.Fatalf("binary relay failed: %v %v", data, err)
	}
	bridge.Close()
	bridge.Close() // Shutdown is idempotent, including deferred cleanup.
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("hijacked connection survived shutdown")
	}
}

func TestBridgeAllowsMacOSWailsOrigin(t *testing.T) {
	requests := make(chan struct{}, 1)
	bridge, err := NewBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		requests <- struct{}{}
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()

	ws, _, err := websocket.DefaultDialer.Dial(bridge.WebSocketBase+"/ws/session", http.Header{"Origin": {WailsOrigin}})
	if err != nil {
		t.Fatalf("macOS Wails origin was rejected: %v", err)
	}
	ws.Close()
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("macOS WebSocket request did not reach the backend")
	}
}

func TestBridgeDoesNotExposeHTTP(t *testing.T) {
	bridge, err := NewBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("HTTP request reached backend")
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	request, _ := http.NewRequest(http.MethodGet, strings.Replace(bridge.WebSocketBase, "ws://", "http://", 1)+"/ws/test", nil)
	request.Header.Set("Origin", Origin)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("HTTP access returned %d", response.StatusCode)
	}
}

func TestBridgeAllowsOnlyAuthenticatedUploadHTTP(t *testing.T) {
	type receivedRequest struct {
		path string
		body string
	}
	received := make(chan receivedRequest, 1)
	bridge, err := NewBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- receivedRequest{path: r.URL.Path, body: string(body)}
		w.WriteHeader(http.StatusCreated)
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()

	request, _ := http.NewRequest(http.MethodPost, bridge.UploadBase+"/api/devices/test/install", strings.NewReader("apk bytes"))
	request.Header.Set("Origin", Origin)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated || response.Header.Get("Access-Control-Allow-Origin") != Origin {
		t.Fatalf("upload returned %d, CORS %q", response.StatusCode, response.Header.Get("Access-Control-Allow-Origin"))
	}
	got := <-received
	if got.path != "/api/devices/test/install" || got.body != "apk bytes" {
		t.Fatalf("upload was not preserved: %+v", got)
	}
	request, _ = http.NewRequest(http.MethodOptions, bridge.UploadBase+"/api/devices/test/install", nil)
	request.Header.Set("Origin", Origin)
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Private-Network", "true")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("upload preflight returned %d", response.StatusCode)
	}

	address := bridge.UploadBase[:strings.LastIndex(bridge.UploadBase, "/")]
	for _, tc := range []struct {
		target string
		origin string
	}{
		{address + "/api/devices/test/install", Origin},
		{bridge.UploadBase + "/api/devices", Origin},
		{bridge.UploadBase + "/api/devices/test/workbench", Origin},
		{bridge.UploadBase + "/api/devices/test/install", "https://evil.example"},
	} {
		request, _ = http.NewRequest(http.MethodPost, tc.target, strings.NewReader("secret"))
		request.Header.Set("Origin", tc.origin)
		response, err = http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusForbidden {
			response.Body.Close()
			t.Fatalf("unexpected HTTP access to %s: %d", tc.target, response.StatusCode)
		}
		response.Body.Close()
	}
}

func TestAssetHandlerInjectsBeforeModulesAndPreservesAPI(t *testing.T) {
	bridge := &Bridge{WebSocketBase: "ws://127.0.0.1:12345/secret", UploadBase: "http://127.0.0.1:12345/secret"}
	assets := fstest.MapFS{"index.html": {Data: []byte(`<html><head><script type="module" src="/app.js"></script></head></html>`)}}
	handler, err := bridge.AssetHandler(assets, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "API response")
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/index.html"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		html := response.Body.String()
		marker := strings.Index(html, "window.__MUGI_DESKTOP__=")
		if marker < 0 || marker > strings.Index(html, `type="module"`) || !strings.Contains(html, bridge.WebSocketBase) || !strings.Contains(html, bridge.UploadBase) {
			t.Fatalf("invalid bootstrap: %s", html)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("ephemeral token can be cached")
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/devices", nil))
	if response.Body.String() != "API response" {
		t.Fatal("API was replaced by frontend HTML")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/", nil))
	if response.Body.Len() != 0 {
		t.Fatal("HEAD returned a body")
	}
}
