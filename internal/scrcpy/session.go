package scrcpy

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"mugi/internal/adb"
	"mugi/internal/hostexec"
)

//go:embed scrcpy-server.bin
var serverBinary []byte

// ServerBinary returns the embedded scrcpy-server payload for browser-side
// transports such as WebUSB. The returned slice is read-only.
func ServerBinary() []byte { return serverBinary }

// ServerVersion must match the vendored scrcpy-server binary exactly.
const ServerVersion = "4.1"

const remoteServerPath = "/data/local/tmp/mugi/scrcpy-server"

// SessionOptions describes one mirror/virtual-display window.
type SessionOptions struct {
	Mode        string `json:"mode"` // "mirror" or "display"
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	DPI         int    `json:"dpi"`
	StartApp    string `json:"startApp"`
	MaxSize     int    `json:"maxSize"`
	BitRate     int    `json:"bitRate"`
	Audio       bool   `json:"audio"`
	Flex        bool   `json:"flex"`
	Decorations bool   `json:"decorations"`
}

// Session is one running scrcpy-server instance (one window).
type Session struct {
	ID         string         `json:"id"`
	Serial     string         `json:"serial"`
	Opts       SessionOptions `json:"opts"`
	DeviceName string         `json:"deviceName"`
	VideoCodec string         `json:"videoCodec"`
	AudioCodec string         `json:"audioCodec,omitempty"`
	Warning    string         `json:"warning,omitempty"`
	CreatedAt  time.Time      `json:"createdAt"`

	video, audio, control    net.Conn
	videoPrefix              []byte
	audioPrefix              []byte
	controlWriteMu           sync.Mutex
	stateMu                  sync.Mutex
	displayPowerOff          bool
	recordDisplayPower       func(bool)
	claimDisplayPowerRestore func() bool
	kill                     func()
	closeOnce                sync.Once
	logTail                  *ringBuffer
}

// Video returns the replayed handshake prefix and the raw video socket.
func (s *Session) Video() ([]byte, net.Conn) { return s.videoPrefix, s.video }

// Audio returns the replayed codec id and the raw audio socket (nil if disabled).
func (s *Session) Audio() ([]byte, net.Conn) { return s.audioPrefix, s.audio }

// Control returns the bidirectional control socket.
func (s *Session) Control() net.Conn { return s.control }

// SetDisplayPowerCoordinator shares physical display state across windows.
func (s *Session) SetDisplayPowerCoordinator(record func(bool), claimRestore func() bool) {
	s.recordDisplayPower = record
	s.claimDisplayPowerRestore = claimRestore
}

// SendControl serializes writes to the scrcpy control socket and tracks
// display power changes so teardown can restore the physical screen.
func (s *Session) SendControl(msg []byte) error {
	s.controlWriteMu.Lock()
	defer s.controlWriteMu.Unlock()
	if s.control == nil {
		return fmt.Errorf("control channel unavailable")
	}
	// Recovery requests must not hang the retry loop on an unresponsive peer.
	if len(msg) > 0 && msg[0] == CtrlResetVideo {
		if err := s.control.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			return err
		}
		defer s.control.SetWriteDeadline(time.Time{})
	}
	if _, err := s.control.Write(msg); err != nil {
		return err
	}
	if len(msg) >= 2 && msg[0] == CtrlSetDisplayPower {
		on := msg[1] != 0
		s.stateMu.Lock()
		s.displayPowerOff = !on
		s.stateMu.Unlock()
		if s.recordDisplayPower != nil {
			s.recordDisplayPower(on)
		}
	}
	return nil
}

// RestoreDisplayPower wakes the display only if this session turned it off.
func (s *Session) RestoreDisplayPower() bool {
	if s.claimDisplayPowerRestore != nil {
		if !s.claimDisplayPowerRestore() {
			return false
		}
	} else {
		s.stateMu.Lock()
		off := s.displayPowerOff
		s.stateMu.Unlock()
		if !off {
			return false
		}
	}
	// SET_DISPLAY_POWER(true) disables scrcpy's keep-display-off behavior.
	// Wait out its pending 200 ms re-off task before injecting the wake key.
	if err := s.SendControl(EncodeSetDisplayPower(true)); err != nil {
		return false
	}
	time.Sleep(250 * time.Millisecond)
	return s.SendControl(EncodeBackOrScreenOn(ActionDown)) == nil
}

// LogTail returns the most recent server log output.
func (s *Session) LogTail() string { return s.logTail.String() }

// Close tears the session down.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		if s.RestoreDisplayPower() {
			time.Sleep(50 * time.Millisecond)
		}
		for _, c := range []net.Conn{s.video, s.audio, s.control} {
			if c != nil {
				_ = c.Close()
			}
		}
		if s.kill != nil {
			s.kill()
		}
	})
}

// Manager owns all sessions.
type Manager struct {
	mu              sync.Mutex
	sessions        map[string]*Session
	displayPowerOff map[string]bool
}

// NewManager creates a Manager.
func NewManager() *Manager {
	return &Manager{
		sessions:        map[string]*Session{},
		displayPowerOff: map[string]bool{},
	}
}

// Register adds an externally-built session (used by backends).
func (m *Manager) Register(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.ID] = s
}

// Get returns a session by id.
func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// List returns all sessions.
func (m *Manager) List() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// Remove deletes a session from the registry.
func (m *Manager) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

// HasAudioSession reports whether another session on the same device streams audio.
func (m *Manager) HasAudioSession(serial, exceptID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.Serial == serial && s.ID != exceptID && s.audio != nil {
			return true
		}
	}
	return false
}

// HasConflictingSession reports whether the device already has a window that
// conflicts with opts: only one mirror is allowed, while virtual displays are
// unique by their startup app (including the empty, unspecified app).
func (m *Manager) HasConflictingSession(serial string, opts SessionOptions) bool {
	mode := opts.Mode
	if mode == "" {
		mode = "mirror"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		sessionMode := s.Opts.Mode
		if sessionMode == "" {
			sessionMode = "mirror"
		}
		if s.Serial != serial || sessionMode != mode {
			continue
		}
		if mode == "mirror" || s.Opts.StartApp == opts.StartApp {
			return true
		}
	}
	return false
}

func (m *Manager) recordDisplayPower(serial string, on bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.displayPowerOff[serial] = !on
}

func (m *Manager) claimDisplayPowerRestore(serial, exceptID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.Serial == serial && s.ID != exceptID {
			return false
		}
	}
	return m.displayPowerOff[serial]
}

// AdbBackend implements the device backend against real devices via adb.
type AdbBackend struct {
	Adb     *adb.Client
	Manager *Manager

	mu     sync.Mutex
	pushed map[string]bool
}

// NewAdbBackend creates an AdbBackend.
func NewAdbBackend(client *adb.Client, m *Manager) *AdbBackend {
	return &AdbBackend{Adb: client, Manager: m, pushed: map[string]bool{}}
}

func (b *AdbBackend) Devices() ([]adb.Device, error) { return b.Adb.Devices() }

func (b *AdbBackend) IsUnlocked(serial string) (bool, error) {
	return b.Adb.IsUnlocked(serial)
}

func (b *AdbBackend) Pair(host string, port int, code string) error {
	return b.Adb.Pair(host, port, code)
}

func (b *AdbBackend) Connect(host string, port int) (string, error) {
	return b.Adb.Connect(host, port)
}

// Release stops the local ADB daemon so the browser can claim the USB ADB
// interface directly through WebUSB.
func (b *AdbBackend) Release() error { return b.Adb.KillServer() }

func (b *AdbBackend) Apps(serial string) ([]adb.App, error) {
	if err := b.ensureServer(serial); err != nil {
		log.Printf("ensureServer(%s): %v (app list may fall back to pm)", serial, err)
	}
	apps, err := b.Adb.Apps(serial)
	if err == nil && len(apps) > 0 {
		keys := b.Adb.AppIconKeys(serial)
		for i := range apps {
			if key := keys[apps[i].Package]; key != "" {
				apps[i].IconURL = "/api/devices/" + url.PathEscape(serial) + "/apps/" + url.PathEscape(apps[i].Package) + "/icon?v=" + key
			}
		}
	}
	return apps, err
}

func (b *AdbBackend) AppIcon(ctx context.Context, serial, pkg, key string) ([]byte, error) {
	return b.Adb.AppIcon(ctx, serial, pkg, key)
}

func (b *AdbBackend) Push(serial, remotePath string, r io.Reader) error {
	return b.Adb.PushBytes(serial, remotePath, r)
}

func (b *AdbBackend) Install(serial string, apk io.Reader) (string, error) {
	file, err := os.CreateTemp("", "mugi-install-*.apk")
	if err != nil {
		return "", fmt.Errorf("暂存 APK 失败: %w", err)
	}
	path := file.Name()
	defer os.Remove(path)
	written, err := io.Copy(file, apk)
	if err != nil {
		_ = file.Close()
		return "", fmt.Errorf("暂存 APK 失败: %w", err)
	}
	if written <= 0 {
		_ = file.Close()
		return "", errors.New("收到的 APK 数据为空，请重新选择文件")
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("暂存 APK 失败: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return b.Adb.InstallSet(ctx, serial, []string{path}, adb.InstallOptions{})
}

func (b *AdbBackend) ListFiles(serial, path string) ([]adb.FileInfo, error) {
	return b.Adb.ListFiles(serial, path)
}

func (b *AdbBackend) Pull(serial, path string, w io.Writer) error {
	return b.Adb.Pull(serial, path, w)
}

func (b *AdbBackend) CreateDirectory(serial, path string) error {
	return b.Adb.CreateDirectory(serial, path)
}

func (b *AdbBackend) CopyFile(serial, oldPath, newPath string) error {
	return b.Adb.CopyFile(serial, oldPath, newPath)
}

func (b *AdbBackend) RenameFile(serial, oldPath, newPath string) error {
	return b.Adb.RenameFile(serial, oldPath, newPath)
}

func (b *AdbBackend) DeleteFile(serial, path string) error {
	return b.Adb.DeleteFile(serial, path)
}

// ensureServer pushes the embedded scrcpy-server binary unless the device
// already holds an identical copy, and remembers the result per device.
func (b *AdbBackend) ensureServer(serial string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pushed[serial] {
		return nil
	}
	if _, err := b.Adb.Shell(serial, 5*time.Second, "mkdir -p /data/local/tmp/mugi"); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	if b.remoteServerCurrent(serial) {
		b.pushed[serial] = true
		return nil
	}
	if err := b.Adb.PushBytes(serial, remoteServerPath, bytes.NewReader(serverBinary)); err != nil {
		return err
	}
	_, _ = b.Adb.Shell(serial, 5*time.Second, "chmod 644 "+remoteServerPath)
	b.pushed[serial] = true
	return nil
}

// StartSession spawns a scrcpy-server instance and connects its sockets. If the
// device lost the pushed binary since it was cached, it re-verifies and retries once.
func (b *AdbBackend) StartSession(serial string, opts SessionOptions) (*Session, error) {
	if err := b.ensureServer(serial); err != nil {
		return nil, err
	}
	sess, err := b.startSession(serial, opts)
	if err == nil || !serverFileMissing(err.Error()) {
		return sess, err
	}
	log.Printf("[session] %s: server binary missing on device, re-pushing", serial)
	b.forgetServer(serial)
	if err := b.ensureServer(serial); err != nil {
		return nil, err
	}
	return b.startSession(serial, opts)
}

func (b *AdbBackend) startSession(serial string, opts SessionOptions) (*Session, error) {
	if opts.Mode == "" {
		opts.Mode = "mirror"
	}
	if opts.BitRate <= 0 {
		opts.BitRate = 8000000
	}

	scid := rand.Int31()
	scidHex := fmt.Sprintf("%08x", scid)
	socketName := "scrcpy_" + scidHex

	// Set up the forward tunnel with an auto-assigned local port.
	port, err := b.Adb.ForwardTCP(serial, "localabstract:"+socketName)
	if err != nil {
		return nil, err
	}

	args := []string{
		"scid=" + scidHex,
		"tunnel_forward=true",
		"log_level=info",
		"cleanup=false",
		"clipboard_autosync=true",
		"power_on=true",
		"video=true",
		"control=true",
		"video_codec=h264",
		fmt.Sprintf("video_bit_rate=%d", opts.BitRate),
	}
	if opts.MaxSize > 0 {
		args = append(args, fmt.Sprintf("max_size=%d", opts.MaxSize))
	}
	if opts.Audio {
		args = append(args, "audio=true", "audio_codec=opus")
	} else {
		args = append(args, "audio=false")
	}
	if opts.Mode == "display" {
		size := ""
		if opts.Width > 0 && opts.Height > 0 {
			size = fmt.Sprintf("%dx%d", opts.Width, opts.Height)
		}
		if opts.DPI > 0 {
			size += fmt.Sprintf("/%d", opts.DPI)
		}
		args = append(args, "new_display="+size, "keep_active=true", "display_ime_policy=local")
		if opts.Flex {
			args = append(args, "flex_display=true")
		}
		if !opts.Decorations {
			args = append(args, "vd_system_decorations=false")
		}
	}

	shellCmdline := "CLASSPATH=" + remoteServerPath + " app_process / com.genymobile.scrcpy.Server " +
		ServerVersion + " " + strings.Join(args, " ")
	log.Printf("[session] %s: %s", serial, shellCmdline)

	shell := hostexec.Command(b.Adb.Bin, "-s", serial, "shell", shellCmdline)
	rb := newRingBuffer(32 << 10)
	shell.Stdout = rb
	shell.Stderr = rb
	if err := shell.Start(); err != nil {
		_ = b.removeForward(serial, port)
		return nil, fmt.Errorf("start server shell: %w", err)
	}
	shellDone := make(chan error, 1)
	go func() {
		shellDone <- shell.Wait()
		close(shellDone)
	}()

	sess := &Session{
		ID:        fmt.Sprintf("s-%d-%d", time.Now().UnixNano()/1e6, rand.Intn(10000)),
		Serial:    serial,
		Opts:      opts,
		CreatedAt: time.Now(),
		logTail:   rb,
	}
	sess.SetDisplayPowerCoordinator(
		func(on bool) { b.Manager.recordDisplayPower(serial, on) },
		func() bool { return b.Manager.claimDisplayPowerRestore(serial, sess.ID) },
	)

	cleanup := func() {
		if shell.Process != nil {
			_ = shell.Process.Kill()
		}
		_ = b.removeForward(serial, port)
	}
	sess.kill = cleanup

	// An adb forward accepts a local TCP connection even when the device-side
	// abstract socket does not exist yet. Wait for the server socket explicitly;
	// otherwise that apparent connection immediately returns EOF.
	if err := b.waitForRemoteSocket(serial, socketName, shellDone); err != nil {
		sess.Close()
		select {
		case <-shellDone:
		case <-time.After(2 * time.Second):
		}
		return nil, fmt.Errorf("server socket: %w\nserver logs:\n%s", err, rb.String())
	}

	dial := func() (net.Conn, error) {
		var conn net.Conn
		var err error
		for i := 0; i < 40; i++ {
			conn, err = net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
			if err == nil {
				return conn, nil
			}
			time.Sleep(250 * time.Millisecond)
		}
		return nil, fmt.Errorf("dial forwarded port %d: %w", port, err)
	}

	fail := func(err error) (*Session, error) {
		sess.Close()
		select {
		case <-shellDone:
		case <-time.After(2 * time.Second):
		}
		return nil, fmt.Errorf("%w\nserver logs:\n%s", err, rb.String())
	}

	// Connect all sockets in protocol order before reading any handshake data.
	// In forward-tunnel mode, the server accepts video, audio and control
	// sequentially, then returns from DesktopConnection.open() and sends device
	// metadata. Reading video metadata before opening the remaining sockets
	// would therefore deadlock on real devices.
	video, err := dial()
	if err != nil {
		return fail(fmt.Errorf("video socket: %w", err))
	}
	sess.video = video

	var audio net.Conn
	if opts.Audio {
		audio, err = dial()
		if err != nil {
			return fail(fmt.Errorf("audio socket: %w", err))
		}
		sess.audio = audio
	}

	control, err := dial()
	if err != nil {
		return fail(fmt.Errorf("control socket: %w", err))
	}
	sess.control = control

	_ = video.SetReadDeadline(time.Now().Add(15 * time.Second))
	name, err := ReadDeviceMeta(video)
	if err != nil {
		return fail(fmt.Errorf("device meta: %w", err))
	}
	vcodec, err := ReadCodecID(video)
	if err != nil {
		return fail(fmt.Errorf("video codec id: %w", err))
	}
	_ = video.SetReadDeadline(time.Time{})
	sess.DeviceName = name
	sess.VideoCodec = CodecName(vcodec)
	// Replay the consumed bytes so the browser sees a complete stream.
	sess.videoPrefix = MakeDevicePrefix(name, vcodec)

	if opts.Audio {
		_ = audio.SetReadDeadline(time.Now().Add(10 * time.Second))
		acodec, err := ReadCodecID(audio)
		if err != nil {
			return fail(fmt.Errorf("audio codec id: %w", err))
		}
		_ = audio.SetReadDeadline(time.Time{})
		sess.AudioCodec = CodecName(acodec)
		sess.audioPrefix = []byte{byte(acodec >> 24), byte(acodec >> 16), byte(acodec >> 8), byte(acodec)}
	}

	go func() {
		<-shellDone
		sess.Close()
		b.Manager.Remove(sess.ID)
	}()

	return sess, nil
}

func (b *AdbBackend) waitForRemoteSocket(serial, socketName string, shellDone <-chan error) error {
	deadline := time.Now().Add(10 * time.Second)
	needle := "@" + socketName
	var lastErr error
	for time.Now().Before(deadline) {
		select {
		case err := <-shellDone:
			if err == nil {
				return fmt.Errorf("server exited before opening %s", needle)
			}
			return fmt.Errorf("server exited before opening %s: %w", needle, err)
		default:
		}

		out, err := b.Adb.Shell(serial, time.Second, "cat /proc/net/unix")
		if err == nil && strings.Contains(out, needle) {
			return nil
		}
		lastErr = err

		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case err := <-shellDone:
			timer.Stop()
			if err == nil {
				return fmt.Errorf("server exited before opening %s", needle)
			}
			return fmt.Errorf("server exited before opening %s: %w", needle, err)
		case <-timer.C:
		}
	}
	if lastErr != nil {
		return fmt.Errorf("timed out waiting for %s: %w", needle, lastErr)
	}
	return fmt.Errorf("timed out waiting for %s", needle)
}

// MakeDevicePrefix rebuilds the dummy byte + device name + codec id header.
func MakeDevicePrefix(name string, codec uint32) []byte {
	buf := make([]byte, 1+64+4)
	copy(buf[1:], name)
	buf[65] = byte(codec >> 24)
	buf[66] = byte(codec >> 16)
	buf[67] = byte(codec >> 8)
	buf[68] = byte(codec)
	return buf
}

var forwardRemoveRe = regexp.MustCompile(`^tcp:\d+$`)

func (b *AdbBackend) removeForward(serial string, port int) error {
	spec := fmt.Sprintf("tcp:%d", port)
	if !forwardRemoveRe.MatchString(spec) {
		return fmt.Errorf("bad forward spec")
	}
	_, _, err := b.Adb.Cmd(5*time.Second, "-s", serial, "forward", "--remove", spec)
	return err
}

// ringBuffer keeps the last N bytes written (for server logs).
type ringBuffer struct {
	mu   sync.Mutex
	buf  []byte
	size int
}

func newRingBuffer(size int) *ringBuffer { return &ringBuffer{size: size} }

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.size {
		r.buf = r.buf[len(r.buf)-r.size:]
	}
	return len(p), nil
}

func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}
