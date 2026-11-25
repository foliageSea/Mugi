package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"mugi/internal/adb"
)

type workbenchBackend interface {
	Workbench(context.Context, string, string, string) (string, error)
	Screenshot(context.Context, string) ([]byte, error)
	ExportAPK(context.Context, string, string, int, io.Writer) error
	InstallSet(context.Context, string, []string, adb.InstallOptions) (string, error)
}

func (s *Server) workbenchBackend(c *gin.Context) (workbenchBackend, bool) {
	b, ok := s.backend.(workbenchBackend)
	if !ok {
		fail(c, http.StatusNotImplemented, errors.New("当前后端不支持设备管理"))
	}
	return b, ok
}

func (s *Server) deviceOperation(c *gin.Context) {
	var req struct {
		Operation string `json:"operation"`
		Value     string `json:"value"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, 400, err)
		return
	}
	if _, err := adb.OperationCommand(req.Operation, req.Value); err != nil {
		fail(c, 400, err)
		return
	}
	b, ok := s.workbenchBackend(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	out, err := b.Workbench(ctx, c.Param("serial"), req.Operation, req.Value)
	if err != nil {
		fail(c, 502, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"output": out})
}

func (s *Server) deviceScreenshot(c *gin.Context) {
	b, ok := s.workbenchBackend(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	data, err := b.Screenshot(ctx, c.Param("serial"))
	if err != nil {
		fail(c, 502, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", `attachment; filename="screenshot.png"`)
	c.Data(200, "image/png", data)
}

func (s *Server) exportAPK(c *gin.Context) {
	pkg := c.Param("package")
	index, err := strconv.Atoi(c.DefaultQuery("index", "0"))
	if !adb.ValidPackage(pkg) || err != nil || index < 0 || index > 255 {
		fail(c, 400, errors.New("无效的应用或 APK 索引"))
		return
	}
	b, ok := s.workbenchBackend(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()
	// Stage to disk so device errors cannot be returned as a successful APK download.
	f, err := os.CreateTemp("", "mugi-export-*.apk")
	if err != nil {
		fail(c, 500, err)
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := b.ExportAPK(ctx, c.Param("serial"), pkg, index, f); err != nil {
		fail(c, 502, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Type", "application/vnd.android.package-archive")
	c.FileAttachment(f.Name(), fmt.Sprintf("%s-%d.apk", pkg, index))
}

func (s *Server) installSet(c *gin.Context) {
	b, ok := s.workbenchBackend(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<30)
	if err := c.Request.ParseMultipartForm(8 << 20); err != nil {
		fail(c, 400, err)
		return
	}
	defer c.Request.MultipartForm.RemoveAll()
	files := c.Request.MultipartForm.File["files"]
	if len(files) < 1 || len(files) > 128 {
		fail(c, 400, errors.New("请选择 1–128 个 APK"))
		return
	}
	dir, err := os.MkdirTemp("", "mugi-install-*")
	if err != nil {
		fail(c, 500, err)
		return
	}
	defer os.RemoveAll(dir)
	var paths []string
	for i, file := range files {
		if !strings.HasSuffix(strings.ToLower(file.Filename), ".apk") || file.Size == 0 {
			fail(c, 400, errors.New("安装包必须是非空 APK"))
			return
		}
		target := filepath.Join(dir, fmt.Sprintf("%03d.apk", i))
		if err := c.SaveUploadedFile(file, target); err != nil {
			fail(c, 500, err)
			return
		}
		paths = append(paths, target)
	}
	opts := adb.InstallOptions{Downgrade: c.PostForm("downgrade") == "true", Test: c.PostForm("test") == "true"}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()
	out, err := b.InstallSet(ctx, c.Param("serial"), paths, opts)
	if err != nil {
		fail(c, 502, err)
		return
	}
	c.JSON(200, gin.H{"output": out})
}
