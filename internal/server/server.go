// Package server exposes the mugi HTTP API and WebSocket relays.
package server

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

const (
	storageRoot     = "/sdcard"
	defaultFilePath = storageRoot + "/Download"
)

// DeviceBackend abstracts device access for the HTTP API.
type DeviceBackend interface {
	Devices() ([]adb.Device, error)
	IsUnlocked(serial string) (bool, error)
	Pair(host string, port int, code string) error
	Connect(host string, port int) (string, error)
	Disconnect(serial string) error
	Apps(serial string) ([]adb.App, error)
	StartSession(serial string, opts scrcpy.SessionOptions) (*scrcpy.Session, error)
	Push(serial, remotePath string, r io.Reader) error
	Install(serial string, apk io.Reader) (string, error)
	ListFiles(serial, path string) ([]adb.FileInfo, error)
	Pull(serial, path string, w io.Writer) error
	CreateDirectory(serial, path string) error
	CopyFile(serial, oldPath, newPath string) error
	RenameFile(serial, oldPath, newPath string) error
	DeleteFile(serial, path string) error
}

// Server wires Gin routes to backends and sessions.
type Server struct {
	adbMu         sync.RWMutex
	sessionMu     sync.Mutex // serializes session admission and prevents duplicate windows
	deviceMu      sync.Mutex // guards pending starts and disconnects by serial
	starting      map[string]int
	disconnecting map[string]bool
	terminals     int // guarded by adbMu
	logcats       int // guarded by adbMu
	backend       DeviceBackend
	manager       *scrcpy.Manager
	accessMode    AccessMode
	upgrader      websocket.Upgrader
	hubsMu        sync.Mutex
	hubs          map[string]*sessionHub // guarded by hubsMu
}

// AccessMode controls how the client network is classified.
type AccessMode string

const (
	AccessAuto     AccessMode = "auto"
	AccessLocal    AccessMode = "local"
	AccessExternal AccessMode = "external"
)

// isLocalNetworkIP reports whether an address belongs to a network that is
// local to the mugi server. Public addresses are deliberately treated as
// external so that a port-forwarded deployment cannot use the host's ADB.
func isLocalNetworkIP(ip net.IP) bool {
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified())
}

func requestClientIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remoteIP := net.ParseIP(strings.TrimSpace(host))
	// Only honor forwarding headers when the immediate peer is local/private.
	// This supports a local reverse proxy without allowing a public caller to
	// spoof an internal address through X-Forwarded-For.
	if isLocalNetworkIP(remoteIP) {
		for _, value := range []string{r.Header.Get("X-Forwarded-For"), r.Header.Get("X-Real-IP")} {
			if value == "" {
				continue
			}
			candidate := strings.TrimSpace(strings.Split(value, ",")[0])
			if ip := net.ParseIP(candidate); ip != nil {
				return ip
			}
		}
	}
	return remoteIP
}

func isExternalRequest(r *http.Request) bool {
	return !isLocalNetworkIP(requestClientIP(r))
}

// New creates the HTTP server.
func New(backend DeviceBackend, m *scrcpy.Manager) *Server {
	return NewWithAccessMode(backend, m, AccessAuto)
}

// NewWithAccessMode creates an HTTP server with an explicit network access
// policy. AccessExternal is useful behind a TCP reverse proxy such as frpc,
// where the original public client IP is not visible to the local service.
func NewWithAccessMode(backend DeviceBackend, m *scrcpy.Manager, mode AccessMode) *Server {
	if mode != AccessLocal && mode != AccessExternal {
		mode = AccessAuto
	}
	return &Server{
		backend:       backend,
		manager:       m,
		accessMode:    mode,
		hubs:          map[string]*sessionHub{},
		starting:      make(map[string]int),
		disconnecting: make(map[string]bool),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true
				}
				u, err := url.Parse(origin)
				return err == nil && u.Host == r.Host
			},
			ReadBufferSize:    64 << 10,
			WriteBufferSize:   64 << 10,
			HandshakeTimeout:  10 * time.Second,
			EnableCompression: false,
		},
	}
}

// Router builds the Gin engine.
func (s *Server) Router(webFS http.FileSystem) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(gin.Logger())

	api := r.Group("/api")
	// Wait for in-flight ADB operations before handing USB ownership to a browser.
	api.Use(func(c *gin.Context) {
		if c.Request.URL.Path == "/api/adb/release" {
			s.adbMu.Lock()
			defer s.adbMu.Unlock()
		} else {
			s.adbMu.RLock()
			defer s.adbMu.RUnlock()
		}
		c.Next()
	})
	{
		api.GET("/capabilities", s.capabilities)

		local := api.Group("")
		local.Use(s.requireLocalAccess)
		local.GET("/devices", s.listDevices)
		local.POST("/devices/pair", s.pairDevice)
		local.POST("/devices/connect", s.connectDevice)
		local.POST("/devices/disconnect", s.disconnectDevice)
		local.POST("/adb/release", s.releaseAdb)
		local.GET("/devices/:serial/apps", s.listApps)
		local.GET("/devices/:serial/apps/:package/icon", s.appIcon)
		local.GET("/devices/:serial/unlock-status", s.unlockStatus)
		local.GET("/devices/:serial/metrics", s.deviceMetrics)
		local.GET("/devices/:serial/logcat/processes", s.logcatProcesses)
		local.DELETE("/devices/:serial/logcat", s.clearLogcat)
		local.POST("/devices/:serial/workbench", s.deviceOperation)
		local.GET("/devices/:serial/screenshot", s.deviceScreenshot)
		local.GET("/devices/:serial/packages/:package/apk", s.exportAPK)
		local.POST("/devices/:serial/install-set", s.installSet)
		local.POST("/devices/:serial/push", s.pushFile)
		local.POST("/devices/:serial/install", s.installAPK)
		local.GET("/devices/:serial/files", s.listFiles)
		local.POST("/devices/:serial/files/transfer", s.transferFiles)
		local.PATCH("/devices/:serial/files", s.renameFile)
		local.DELETE("/devices/:serial/files", s.deleteFile)
		local.POST("/devices/:serial/directories", s.createDirectory)
		local.GET("/devices/:serial/pull", s.pullFile)
		local.GET("/scrcpy-server", s.scrcpyServer)

		local.POST("/devices/:serial/sessions", s.startSession)
		local.GET("/sessions", s.listSessions)
		local.GET("/sessions/:id", s.getSession)
		local.GET("/sessions/:id/logs", s.sessionLogs)
		local.DELETE("/sessions/:id", s.stopSession)
	}

	r.GET("/ws/devices/:serial/terminal", s.requireLocalAccess, s.deviceTerminal)
	r.GET("/ws/devices/:serial/logcat", s.requireLocalAccess, s.deviceLogcat)
	r.GET("/ws/sessions/:id/:channel", func(c *gin.Context) {
		if s.externalRequest(c.Request) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "外网访问仅支持 WebUSB，系统 ADB 投屏连接已禁用",
			})
			return
		}
		s.channelWS(c)
	})

	assets := http.FileServer(webFS)
	r.GET("/", gin.WrapH(assets))
	r.GET("/assets/*filepath", gin.WrapH(assets))
	r.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	})
	return r
}

func (s *Server) externalRequest(r *http.Request) bool {
	switch s.accessMode {
	case AccessLocal:
		return false
	case AccessExternal:
		return true
	default:
		return isExternalRequest(r)
	}
}

func (s *Server) requireLocalAccess(c *gin.Context) {
	if s.externalRequest(c.Request) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": "外网访问仅支持 WebUSB，系统 ADB、USB 和无线连接已禁用",
		})
		return
	}
	c.Next()
}

func (s *Server) capabilities(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	external := s.externalRequest(c.Request)
	c.JSON(http.StatusOK, gin.H{
		"network":       map[bool]string{true: "external", false: "local"}[external],
		"adbAllowed":    !external,
		"webusbAllowed": true,
	})
}

func (s *Server) scrcpyServer(c *gin.Context) {
	c.Data(http.StatusOK, "application/octet-stream", scrcpy.ServerBinary())
}

type adbReleaser interface {
	Release() error
}

func (s *Server) releaseAdb(c *gin.Context) {
	if len(s.manager.List()) != 0 || s.terminals != 0 || s.logcats != 0 {
		fail(c, http.StatusConflict, errors.New("请先关闭系统 ADB 投屏窗口、终端和 Logcat，再释放 USB"))
		return
	}
	if releaser, ok := s.backend.(adbReleaser); ok {
		if err := releaser.Release(); err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
	} else {
		fail(c, http.StatusNotImplemented, errors.New("当前后端不支持释放系统 ADB"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func fail(c *gin.Context, code int, err error) {
	c.JSON(code, gin.H{"error": err.Error()})
}

func (s *Server) listDevices(c *gin.Context) {
	devices, err := s.backend.Devices()
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"devices": devices})
}

func (s *Server) unlockStatus(c *gin.Context) {
	unlocked, err := s.backend.IsUnlocked(c.Param("serial"))
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"unlocked": unlocked})
}

type pairRequest struct {
	Host string `json:"host" binding:"required"`
	Port int    `json:"port" binding:"required"`
	Code string `json:"code" binding:"required"`
}

func (s *Server) pairDevice(c *gin.Context) {
	var req pairRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := s.backend.Pair(req.Host, req.Port, req.Code); err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type connectRequest struct {
	Host string `json:"host" binding:"required"`
	Port int    `json:"port"`
}

func (s *Server) connectDevice(c *gin.Context) {
	var req connectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if req.Port == 0 {
		req.Port = 5555
	}
	serial, err := s.backend.Connect(req.Host, req.Port)
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "serial": serial})
}

func (s *Server) disconnectDevice(c *gin.Context) {
	var req struct {
		Serial string `json:"serial" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if strings.ContainsAny(req.Serial, " \t\r\n\x00") {
		fail(c, http.StatusBadRequest, errors.New("invalid ADB serial"))
		return
	}

	if err := s.beginDisconnect(req.Serial); err != nil {
		fail(c, http.StatusConflict, err)
		return
	}
	defer func() {
		s.deviceMu.Lock()
		delete(s.disconnecting, req.Serial)
		s.deviceMu.Unlock()
	}()

	err := s.backend.Disconnect(req.Serial)
	switch {
	case errors.Is(err, adb.ErrDeviceNotFound):
		fail(c, http.StatusNotFound, err)
	case errors.Is(err, adb.ErrNotNetworkDevice):
		fail(c, http.StatusBadRequest, err)
	case err != nil:
		fail(c, http.StatusBadGateway, err)
	default:
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func (s *Server) beginDisconnect(serial string) error {
	s.deviceMu.Lock()
	defer s.deviceMu.Unlock()
	if s.disconnecting[serial] {
		return errors.New("正在断开该 ADB 设备")
	}
	if s.starting[serial] > 0 {
		return errors.New("该设备正在启动投屏，请等待启动完成后关闭投屏窗口，再断开连接")
	}
	for _, session := range s.manager.List() {
		if session.Serial == serial {
			return errors.New("请先关闭该设备的投屏窗口，再断开 ADB 连接")
		}
	}
	s.disconnecting[serial] = true
	return nil
}

func (s *Server) listApps(c *gin.Context) {
	apps, err := s.backend.Apps(c.Param("serial"))
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"apps": apps})
}

func sanitizeRemotePath(p string) (string, error) {
	if p == "" || strings.ContainsAny(p, "\r\n\x00") || !strings.HasPrefix(p, "/") {
		return "", errors.New("invalid remote path")
	}
	clean := path.Clean(p)
	if clean != storageRoot && !strings.HasPrefix(clean, storageRoot+"/") {
		return "", errors.New("path must be inside /sdcard")
	}
	return clean, nil
}

func validateFileName(name string) error {
	if name == "" || name == "." || name == ".." || path.Base(name) != name || strings.ContainsAny(name, "/\r\n\x00") {
		return errors.New("invalid file name")
	}
	return nil
}

func (s *Server) pushFile(c *gin.Context) {
	serial := c.Param("serial")
	fh, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	remoteDir, err := sanitizeRemotePath(c.DefaultPostForm("dir", defaultFilePath))
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	f, err := fh.Open()
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()
	if err := validateFileName(path.Base(fh.Filename)); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	remotePath := path.Join(remoteDir, path.Base(fh.Filename))
	if err := s.backend.Push(serial, remotePath, f); err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": remotePath})
}

func (s *Server) installAPK(c *gin.Context) {
	serial := c.Param("serial")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<30)
	defer func() {
		if c.Request.MultipartForm != nil {
			_ = c.Request.MultipartForm.RemoveAll()
		}
	}()
	fh, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if !strings.HasSuffix(strings.ToLower(fh.Filename), ".apk") {
		fail(c, http.StatusBadRequest, errors.New("not an .apk file"))
		return
	}
	if fh.Size <= 0 {
		fail(c, http.StatusBadRequest, errors.New("APK 文件为空，请重新选择"))
		return
	}
	f, err := fh.Open()
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()
	out, err := s.backend.Install(serial, f)
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "output": out})
}

func (s *Server) listFiles(c *gin.Context) {
	serial := c.Param("serial")
	p := c.DefaultQuery("path", defaultFilePath)
	rp, err := sanitizeRemotePath(p)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if rp == storageRoot {
		fail(c, http.StatusBadRequest, errors.New("cannot open the storage root"))
		return
	}
	files, err := s.backend.ListFiles(serial, rp)
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": rp, "files": files})
}

type filePathRequest struct {
	Path string `json:"path" binding:"required"`
}

func (s *Server) createDirectory(c *gin.Context) {
	var req filePathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	rp, err := sanitizeRemotePath(req.Path)
	if err != nil || rp == storageRoot {
		if err == nil {
			err = errors.New("cannot create the storage root")
		}
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := validateFileName(path.Base(rp)); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := s.backend.CreateDirectory(c.Param("serial"), rp); err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "path": rp})
}

type renameFileRequest struct {
	Path string `json:"path" binding:"required"`
	Name string `json:"name" binding:"required"`
}

type transferFilesRequest struct {
	Paths       []string `json:"paths" binding:"required"`
	Destination string   `json:"destination" binding:"required"`
	Mode        string   `json:"mode" binding:"required"`
}

func (s *Server) transferFiles(c *gin.Context) {
	var req transferFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > 200 {
		fail(c, http.StatusBadRequest, errors.New("paths must contain between 1 and 200 items"))
		return
	}
	if req.Mode != "copy" && req.Mode != "move" {
		fail(c, http.StatusBadRequest, errors.New("mode must be copy or move"))
		return
	}
	destination, err := sanitizeRemotePath(req.Destination)
	if err != nil || destination == storageRoot {
		if err == nil {
			err = errors.New("cannot transfer files to the storage root")
		}
		fail(c, http.StatusBadRequest, err)
		return
	}
	type transfer struct{ source, target string }
	transfers := make([]transfer, 0, len(req.Paths))
	targets := make(map[string]bool, len(req.Paths))
	for _, item := range req.Paths {
		source, pathErr := sanitizeRemotePath(item)
		if pathErr != nil || source == storageRoot {
			if pathErr == nil {
				pathErr = errors.New("cannot transfer the storage root")
			}
			fail(c, http.StatusBadRequest, pathErr)
			return
		}
		if destination == source || strings.HasPrefix(destination, source+"/") {
			fail(c, http.StatusBadRequest, errors.New("cannot transfer an item into itself"))
			return
		}
		target := path.Join(destination, path.Base(source))
		if target == source {
			fail(c, http.StatusBadRequest, errors.New("source and destination are the same"))
			return
		}
		if targets[target] {
			fail(c, http.StatusBadRequest, errors.New("multiple sources have the same name"))
			return
		}
		targets[target] = true
		transfers = append(transfers, transfer{source: source, target: target})
	}
	for index, item := range transfers {
		if req.Mode == "copy" {
			err = s.backend.CopyFile(c.Param("serial"), item.source, item.target)
		} else {
			err = s.backend.RenameFile(c.Param("serial"), item.source, item.target)
		}
		if err != nil {
			fail(c, http.StatusBadGateway, fmt.Errorf("transfer item %d: %w", index+1, err))
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(transfers)})
}

func (s *Server) renameFile(c *gin.Context) {
	var req renameFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	oldPath, err := sanitizeRemotePath(req.Path)
	if err != nil || oldPath == storageRoot {
		if err == nil {
			err = errors.New("cannot rename the storage root")
		}
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := validateFileName(req.Name); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	newPath, err := sanitizeRemotePath(path.Join(path.Dir(oldPath), req.Name))
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := s.backend.RenameFile(c.Param("serial"), oldPath, newPath); err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": newPath})
}

type deleteFilesRequest struct {
	Path  string   `json:"path"`
	Paths []string `json:"paths"`
}

func (s *Server) deleteFile(c *gin.Context) {
	var req deleteFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	paths := req.Paths
	if req.Path != "" {
		paths = append(paths, req.Path)
	}
	if len(paths) == 0 || len(paths) > 200 {
		fail(c, http.StatusBadRequest, errors.New("path or paths must contain between 1 and 200 items"))
		return
	}
	cleaned := make([]string, 0, len(paths))
	for _, item := range paths {
		rp, err := sanitizeRemotePath(item)
		if err != nil || rp == storageRoot {
			if err == nil {
				err = errors.New("cannot delete the storage root")
			}
			fail(c, http.StatusBadRequest, err)
			return
		}
		cleaned = append(cleaned, rp)
	}
	for index, rp := range cleaned {
		if err := s.backend.DeleteFile(c.Param("serial"), rp); err != nil {
			fail(c, http.StatusBadGateway, fmt.Errorf("delete item %d: %w", index+1, err))
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(cleaned)})
}

func (s *Server) pullFile(c *gin.Context) {
	serial := c.Param("serial")
	rp, err := sanitizeRemotePath(c.Query("path"))
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	disposition := "attachment"
	contentType := "application/octet-stream"
	if c.Query("preview") == "1" {
		disposition = "inline"
		if detected := mime.TypeByExtension(strings.ToLower(path.Ext(rp))); detected != "" {
			contentType = detected
		}
	}
	c.Header("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(rp)}))
	c.Header("Content-Type", contentType)
	if err := s.backend.Pull(serial, rp, c.Writer); err != nil {
		// Headers may already be sent; best effort.
		c.Error(err)
	}
}

func (s *Server) startSession(c *gin.Context) {
	serial := c.Param("serial")
	var opts scrcpy.SessionOptions
	if err := c.ShouldBindJSON(&opts); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := validateSessionOptions(&opts); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	// Reserve this serial before probing it, so a disconnect cannot race a
	// starting session between its unlock check and registration.
	s.deviceMu.Lock()
	if s.disconnecting[serial] {
		s.deviceMu.Unlock()
		fail(c, http.StatusConflict, errors.New("正在断开该 ADB 设备"))
		return
	}
	s.starting[serial]++
	s.deviceMu.Unlock()
	defer func() {
		s.deviceMu.Lock()
		s.starting[serial]--
		if s.starting[serial] == 0 {
			delete(s.starting, serial)
		}
		s.deviceMu.Unlock()
	}()

	unlocked, err := s.backend.IsUnlocked(serial)
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	if !unlocked {
		fail(c, http.StatusConflict, errors.New("请先解锁手机"))
		return
	}
	// Keep the admission check and registration together so concurrent requests
	// cannot create a duplicate mirror or app window for one device.
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if s.manager.HasConflictingSession(serial, opts) {
		message := "该设备已打开一个屏幕镜像窗口"
		if opts.Mode == "display" && opts.StartApp == "" {
			message = "该设备已打开一个未指定应用的投屏窗口"
		} else if opts.Mode == "display" {
			message = "该应用已打开投屏窗口"
		}
		fail(c, http.StatusConflict, errors.New(message))
		return
	}
	if opts.Audio && s.manager.HasAudioSession(serial, "") {
		opts.Audio = false
		sess, err := s.backend.StartSession(serial, opts)
		if err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
		sess.Warning = "另一窗口已占用音频转发，本窗口音频已禁用"
		s.manager.Register(sess)
		c.JSON(http.StatusOK, sess)
		return
	}
	sess, err := s.backend.StartSession(serial, opts)
	if err != nil {
		fail(c, http.StatusBadGateway, err)
		return
	}
	s.manager.Register(sess)
	c.JSON(http.StatusOK, sess)
}

var packageNameRe = regexp.MustCompile(`^[A-Za-z0-9_.$-]*$`)

func validateSessionOptions(opts *scrcpy.SessionOptions) error {
	if opts.Mode == "" {
		opts.Mode = "mirror"
	}
	if opts.Mode != "mirror" && opts.Mode != "display" {
		return errors.New("mode must be mirror or display")
	}
	if opts.Width < 0 || opts.Width > 4096 || opts.Height < 0 || opts.Height > 4096 {
		return errors.New("display dimensions must be between 0 and 4096")
	}
	if opts.Mode == "display" && ((opts.Width == 0) != (opts.Height == 0)) {
		return errors.New("display width and height must be provided together")
	}
	if opts.DPI != 0 && (opts.DPI < 72 || opts.DPI > 640) {
		return errors.New("display DPI must be between 72 and 640")
	}
	if opts.MaxSize < 0 || opts.MaxSize > 4096 {
		return errors.New("maxSize must be between 0 and 4096")
	}
	if opts.BitRate != 0 && (opts.BitRate < 100000 || opts.BitRate > 50000000) {
		return errors.New("bitRate must be between 100000 and 50000000")
	}
	if len(opts.StartApp) > 255 || !packageNameRe.MatchString(opts.StartApp) {
		return errors.New("invalid startApp package name")
	}
	return nil
}

func (s *Server) listSessions(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"sessions": s.manager.List()})
}

func (s *Server) getSession(c *gin.Context) {
	sess := s.manager.Get(c.Param("id"))
	if sess == nil {
		fail(c, http.StatusNotFound, errors.New("session not found"))
		return
	}
	c.JSON(http.StatusOK, sess)
}

func (s *Server) sessionLogs(c *gin.Context) {
	sess := s.manager.Get(c.Param("id"))
	if sess == nil {
		fail(c, http.StatusNotFound, errors.New("session not found"))
		return
	}
	c.String(http.StatusOK, sess.LogTail())
}

func (s *Server) stopSession(c *gin.Context) {
	id := c.Param("id")
	sess := s.manager.Get(id)
	if sess == nil {
		fail(c, http.StatusNotFound, errors.New("session not found"))
		return
	}
	sess.Close()
	s.manager.Remove(id)
	s.dropHub(id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// channelWS attaches one WebSocket consumer to a session's channel pump.
// Detaching does not tear the session down: the device stream keeps flowing
// so the consumer can re-attach (network hiccup, page reload) within the
// idle timeout. Video re-attaches force a fresh config packet + keyframe.
func (s *Server) channelWS(c *gin.Context) {
	sess := s.manager.Get(c.Param("id"))
	if sess == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	channel := c.Param("channel")
	if channel != "video" && channel != "audio" && channel != "control" {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown channel"})
		return
	}
	hub := s.hubFor(sess)
	pump := hub.pumps[channel]
	if pump == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not available"})
		return
	}
	sub, reattached, err := pump.attach()
	if err != nil {
		c.JSON(http.StatusGone, gin.H{"error": err.Error()})
		return
	}
	hub.attached()
	defer func() {
		pump.detach(sub)
		hub.detached()
	}()

	ws, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// A re-attached video consumer needs codec config and a keyframe to resume
	// decoding; ask the server to restart the encoding session.
	if reattached && channel == "video" {
		_ = sess.SendControl(scrcpy.EncodeResetVideo())
	}

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	defer finish()

	// Reading the WS detects client disappearance promptly (close frames, dead
	// peers); control messages are the only payload the client sends.
	go func() {
		for {
			mt, data, err := ws.ReadMessage()
			if err != nil {
				finish()
				return
			}
			if mt != websocket.BinaryMessage || channel != "control" {
				continue
			}
			if err := sess.SendControl(data); err != nil {
				finish()
				return
			}
		}
	}()

	write := func(data []byte) error {
		_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return ws.WriteMessage(websocket.BinaryMessage, data)
	}
	if len(pump.prefix) > 0 {
		if err := write(pump.prefix); err != nil {
			return
		}
	}
	for {
		select {
		case data, ok := <-sub:
			if !ok {
				return
			}
			if err := write(data); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}
