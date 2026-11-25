package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"mugi/internal/adb"
)

type metricsBackend interface {
	Metrics(context.Context, string) (string, error)
}
type terminalBackend interface {
	OpenTerminal(string, uint16, uint16) (adb.Terminal, error)
}

func (s *Server) deviceMetrics(c *gin.Context) {
	backend, ok := s.backend.(metricsBackend)
	if !ok {
		fail(c, http.StatusNotImplemented, errors.New("当前设备不支持性能监控"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	out, err := backend.Metrics(ctx, c.Param("serial"))
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"snapshot": out})
}

func terminalSize(value string, fallback int) uint16 {
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 500 {
		return uint16(fallback)
	}
	return uint16(n)
}

func (s *Server) deviceTerminal(c *gin.Context) {
	backend, ok := s.backend.(terminalBackend)
	if !ok {
		fail(c, http.StatusNotImplemented, errors.New("当前设备不支持终端"))
		return
	}
	// Upgrade before creating a process so rejected origins cannot open shells.
	ws, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(64 << 10)
	s.adbMu.Lock()
	terminal, err := backend.OpenTerminal(c.Param("serial"), terminalSize(c.Query("rows"), 24), terminalSize(c.Query("cols"), 80))
	if err == nil {
		s.terminals++
	}
	s.adbMu.Unlock()
	if err != nil {
		_ = ws.WriteJSON(gin.H{"type": "error", "message": err.Error()})
		return
	}
	defer func() {
		_ = terminal.Close()
		s.adbMu.Lock()
		s.terminals--
		s.adbMu.Unlock()
	}()
	_ = ws.WriteJSON(gin.H{"type": "ready"})
	_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
					_ = ws.Close()
					return
				}
			}
		}
	}()
	outputDone := make(chan struct{})
	ack := make(chan struct{}, 1)
	go func() {
		defer close(outputDone)
		defer ws.Close()
		buffer := make([]byte, 16<<10)
		for {
			n, err := terminal.Read(buffer)
			if n > 0 {
				_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if ws.WriteMessage(websocket.BinaryMessage, buffer[:n]) != nil {
					return
				}
				select {
				case <-ack:
				case <-done:
					return
				case <-time.After(10 * time.Second):
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { close(done); _ = terminal.Close(); _ = ws.Close(); <-outputDone }()
	for {
		var message struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Rows uint16 `json:"rows"`
			Cols uint16 `json:"cols"`
		}
		if ws.ReadJSON(&message) != nil {
			return
		}
		switch message.Type {
		case "ack":
			select {
			case ack <- struct{}{}:
			default:
			}
		case "input":
			if _, err := terminal.Write([]byte(message.Data)); err != nil {
				return
			}
		case "resize":
			if message.Rows < 1 || message.Rows > 500 || message.Cols < 1 || message.Cols > 500 {
				return
			}
			if terminal.Resize(message.Rows, message.Cols) != nil {
				return
			}
		default:
			return
		}
	}
}
