// Package desktop adapts the HTTP workbench to a native WebView. Wails handles
// assets and REST requests in-process; WebSockets need a real TCP connection.
package desktop

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Windows WebView2 serves the bundled page from this HTTP origin.
	Origin = "http://wails.localhost"
	// WKWebView uses the custom Wails scheme on macOS (and Linux).
	WailsOrigin = "wails://localhost"
)

func isAllowedOrigin(origin string) bool {
	return origin == Origin || origin == WailsOrigin
}

// Bridge exposes authenticated WebSockets and file uploads on an ephemeral
// loopback port. Other REST endpoints remain available only in-process.
type Bridge struct {
	WebSocketBase string
	UploadBase    string
	server        *http.Server
	listener      *trackedListener
	once          sync.Once
}

func NewBridge(handler http.Handler) (*Bridge, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, fmt.Errorf("desktop token: %w", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	prefix := "/" + hex.EncodeToString(secret[:])
	listener := &trackedListener{Listener: ln, connections: make(map[*trackedConn]struct{})}
	bridge := &Bridge{
		WebSocketBase: "ws://" + ln.Addr().String() + prefix,
		UploadBase:    "http://" + ln.Addr().String() + prefix,
		listener:      listener,
	}
	bridge.server = &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if !isAllowedOrigin(origin) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			strippedPath, hasToken := strings.CutPrefix(r.URL.Path, prefix)
			webSocket := hasToken && strings.HasPrefix(strippedPath, "/ws/") && websocket.IsWebSocketUpgrade(r)
			uploadPath := hasToken && isUploadPath(strippedPath)
			if uploadPath && r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") == http.MethodPost {
				setUploadCORS(w, origin)
				w.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
				if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
					w.Header().Set("Access-Control-Allow-Private-Network", "true")
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
			upload := uploadPath && r.Method == http.MethodPost
			if !webSocket && !upload {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			// Authentication above proves this is our WebView. Adapt the request to
			// the existing same-origin upgrader without weakening its browser policy.
			r = r.Clone(r.Context())
			r.URL.Path = strippedPath
			r.URL.RawPath = ""
			if webSocket {
				r.Header.Set("Origin", "http://"+r.Host)
			} else {
				setUploadCORS(w, origin)
			}
			handler.ServeHTTP(w, r)
		}),
	}
	go func() { _ = bridge.server.Serve(listener) }()
	return bridge, nil
}

func setUploadCORS(w http.ResponseWriter, origin string) {
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
}

func isUploadPath(path string) bool {
	if !strings.HasPrefix(path, "/api/devices/") {
		return false
	}
	return strings.HasSuffix(path, "/install") || strings.HasSuffix(path, "/install-set") || strings.HasSuffix(path, "/push")
}

// Close also closes hijacked WebSocket connections, which http.Server.Close
// deliberately leaves open. This ends Logcat/Shell processes on application exit.
func (b *Bridge) Close() {
	b.once.Do(func() {
		_ = b.server.Close()
		b.listener.mu.Lock()
		connections := make([]*trackedConn, 0, len(b.listener.connections))
		for conn := range b.listener.connections {
			connections = append(connections, conn)
		}
		b.listener.mu.Unlock()
		for _, conn := range connections {
			_ = conn.Close()
		}
	})
}

// AssetHandler injects configuration before the frontend's module script. The
// ordinary browser entry never receives this marker or loads the Wails runtime.
func (b *Bridge) AssetHandler(assets fs.FS, handler http.Handler) (http.Handler, error) {
	index, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return nil, err
	}
	config, err := json.Marshal(struct {
		WebSocketBase string `json:"webSocketBase"`
		UploadBase    string `json:"uploadBase"`
	}{b.WebSocketBase, b.UploadBase})
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(index, []byte("<head>")) {
		return nil, fmt.Errorf("frontend index.html has no <head>")
	}
	index = bytes.Replace(index, []byte("<head>"), []byte("<head><script>window.__MUGI_DESKTOP__="+string(config)+";</script>"), 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
			return
		}
		handler.ServeHTTP(w, r)
	}), nil
}

type trackedListener struct {
	net.Listener
	mu          sync.Mutex
	connections map[*trackedConn]struct{}
}

func (l *trackedListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked := &trackedConn{Conn: conn, listener: l}
	l.mu.Lock()
	l.connections[tracked] = struct{}{}
	l.mu.Unlock()
	return tracked, nil
}

type trackedConn struct {
	net.Conn
	listener *trackedListener
}

func (c *trackedConn) Close() error {
	err := c.Conn.Close()
	c.listener.mu.Lock()
	delete(c.listener.connections, c)
	c.listener.mu.Unlock()
	return err
}
