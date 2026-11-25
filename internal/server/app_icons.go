package server

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"mugi/internal/adb"
)

type appIconBackend interface {
	AppIcon(ctx context.Context, serial, pkg, key string) ([]byte, error)
}

func (s *Server) appIcon(c *gin.Context) {
	pkg, key := c.Param("package"), c.Query("v")
	if !adb.ValidAppIconRequest(pkg, key) {
		c.Status(http.StatusBadRequest)
		return
	}
	backend, ok := s.backend.(appIconBackend)
	if !ok {
		c.Status(http.StatusNotFound)
		return
	}
	data, err := backend.AppIcon(c.Request.Context(), c.Param("serial"), pkg, key)
	if err != nil {
		c.Header("Cache-Control", "no-store")
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "private, max-age=86400, immutable")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "image/png", data)
}
