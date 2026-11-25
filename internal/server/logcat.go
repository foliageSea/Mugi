package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type logcatBackend interface {
	OpenLogcat(context.Context, string) (io.ReadCloser, error)
	ClearLogcat(context.Context, string) error
	LogcatProcesses(context.Context, string) (string, error)
}

func (s *Server) getLogcatBackend(c *gin.Context) (logcatBackend, bool) {
	b, ok := s.backend.(logcatBackend)
	if !ok {
		fail(c, http.StatusNotImplemented, errors.New("当前设备不支持 Logcat"))
	}
	return b, ok
}

func (s *Server) clearLogcat(c *gin.Context) {
	b, ok := s.getLogcatBackend(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	if err := b.ClearLogcat(ctx, c.Param("serial")); err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) logcatProcesses(c *gin.Context) {
	b, ok := s.getLogcatBackend(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	out, err := b.LogcatProcesses(ctx, c.Param("serial"))
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"output": out})
}

func (s *Server) deviceLogcat(c *gin.Context) {
	b, ok := s.getLogcatBackend(c)
	if !ok {
		return
	}
	ws, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()
	// The release endpoint must not kill ADB while a Logcat stream is active.
	s.adbMu.Lock()
	stream, err := b.OpenLogcat(ctx, c.Param("serial"))
	if err == nil {
		s.logcats++
	}
	s.adbMu.Unlock()
	writeJSON := func(message gin.H) error {
		_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return ws.WriteJSON(message)
	}
	if err != nil {
		_ = writeJSON(gin.H{"type": "error", "message": err.Error()})
		return
	}
	defer func() {
		_ = stream.Close()
		s.adbMu.Lock()
		s.logcats--
		s.adbMu.Unlock()
	}()
	if writeJSON(gin.H{"type": "ready"}) != nil {
		return
	}
	ws.SetReadLimit(1024)
	_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	ack := make(chan struct{}, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		defer stream.Close() // Unblock device Read even when it is silent.
		for {
			var msg struct {
				Type string `json:"type"`
			}
			if ws.ReadJSON(&msg) != nil || msg.Type != "ack" {
				return
			}
			select {
			case ack <- struct{}{}:
			default:
			}
		}
	}()
	defer func() { _ = ws.Close(); <-readerDone }()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
					_ = ws.Close()
					return
				}
			}
		}
	}()
	buffer := make([]byte, 16<<10)
	for {
		n, readErr := stream.Read(buffer)
		if n > 0 {
			_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			// This handler is the only data writer. WriteControl is concurrency-safe.
			if ws.WriteMessage(websocket.BinaryMessage, buffer[:n]) != nil {
				return
			}
			timer := time.NewTimer(30 * time.Second)
			select {
			case <-ack:
				timer.Stop()
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				return
			}
		}
		if readErr != nil {
			message := "Logcat 已结束，设备可能已断开"
			if !errors.Is(readErr, io.EOF) {
				message = readErr.Error()
			}
			_ = writeJSON(gin.H{"type": "error", "message": message})
			return
		}
	}
}
