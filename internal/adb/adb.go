// Package adb wraps the local adb binary (Android platform-tools).
package adb

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"mugi/internal/hostexec"
)

// Device is one adb-visible device.
type Device struct {
	Serial string `json:"serial"`
	State  string `json:"state"` // device, unauthorized, offline
	Model  string `json:"model"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// App is a launchable application.
type App struct {
	Name       string `json:"name"`
	Package    string `json:"package"`
	System     bool   `json:"system"`
	Launchable bool   `json:"launchable"`
	IconURL    string `json:"iconUrl,omitempty"`
}

// FileInfo describes a remote file.
type FileInfo struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"isDir"`
	Mtime int64  `json:"mtime"`
}

// Client locates and shells out to the adb binary.
type Client struct {
	Bin string
}

// New returns a Client using the adb binary found in PATH (or the ADB
// environment variable).
func New() (*Client, error) {
	name := os.Getenv("ADB")
	if name == "" {
		name = "adb"
	}
	bin, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("cannot find adb (%s); please install Android platform-tools: %w", name, err)
	}
	return &Client{Bin: bin}, nil
}

func (c *Client) run(timeout time.Duration, args ...string) (string, string, error) {
	cmd := hostexec.Command(c.Bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if timeout > 0 {
		done := make(chan error, 1)
		go func() {
			done <- cmd.Run()
		}()
		select {
		case err := <-done:
			return stdout.String(), stderr.String(), err
		case <-time.After(timeout):
			_ = cmd.Process.Kill()
			<-done
			return stdout.String(), stderr.String(), fmt.Errorf("adb %s: timeout", strings.Join(args, " "))
		}
	}
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// Devices lists connected devices.
func (c *Client) Devices() ([]Device, error) {
	out, _, err := c.run(10*time.Second, "devices", "-l")
	if err != nil {
		return nil, err
	}
	devices := make([]Device, 0)
	sc := bufio.NewScanner(strings.NewReader(out))
	modelRe := regexp.MustCompile(`model:(\S+)`)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(line, "*") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		d := Device{Serial: fields[0], State: fields[1]}
		if m := modelRe.FindStringSubmatch(line); m != nil {
			d.Model = m[1]
		}
		if d.State == "device" {
			d.Width, d.Height, _ = c.DisplaySize(d.Serial)
		}
		devices = append(devices, d)
	}
	return devices, nil
}

var displaySizeRe = regexp.MustCompile(`(?m)^Physical size:\s*(\d+)x(\d+)\s*$`)

// DisplaySize returns the physical dimensions reported by Android.
func (c *Client) DisplaySize(serial string) (int, int, error) {
	out, err := c.Shell(serial, 5*time.Second, "wm size")
	if err != nil {
		return 0, 0, err
	}
	width, height := parseDisplaySize(out)
	if width == 0 || height == 0 {
		return 0, 0, fmt.Errorf("wm size returned invalid output: %q", strings.TrimSpace(out))
	}
	return width, height, nil
}

func parseDisplaySize(output string) (int, int) {
	match := displaySizeRe.FindStringSubmatch(strings.ReplaceAll(output, "\r", ""))
	if match == nil {
		return 0, 0
	}
	width, _ := strconv.Atoi(match[1])
	height, _ := strconv.Atoi(match[2])
	return width, height
}

// Pair pairs with a device over wireless debugging (Android 11+).
func (c *Client) Pair(host string, port int, code string) error {
	out, errOut, err := c.run(30*time.Second, "pair", fmt.Sprintf("%s:%d", host, port), code)
	if err != nil {
		return fmt.Errorf("pair failed: %v: %s%s", err, out, errOut)
	}
	if !strings.Contains(out, "Successfully paired") {
		return fmt.Errorf("pair failed: %s", strings.TrimSpace(out+errOut))
	}
	return nil
}

// Connect connects to a wireless-debugging device.
func (c *Client) Connect(host string, port int) (string, error) {
	out, errOut, err := c.run(15*time.Second, "connect", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return "", fmt.Errorf("connect failed: %v: %s%s", err, out, errOut)
	}
	if strings.Contains(out, "failed") || strings.Contains(out, "cannot") {
		return "", fmt.Errorf("connect failed: %s", strings.TrimSpace(out))
	}
	return fmt.Sprintf("%s:%d", host, port), nil
}

// KillServer releases USB interfaces claimed by the local adb server. This is
// used before a browser takes ownership of the ADB interface through WebUSB.
func (c *Client) KillServer() error {
	_, stderr, err := c.run(10*time.Second, "kill-server")
	if err != nil {
		return fmt.Errorf("adb kill-server failed: %v: %s", err, stderr)
	}
	return nil
}

// Shell runs a shell command on the device and returns stdout.
func (c *Client) Shell(serial string, timeout time.Duration, command string) (string, error) {
	out, _, err := c.run(timeout, "-s", serial, "shell", command)
	return out, err
}

// IsUnlocked reports whether the device is awake and the keyguard is not
// currently showing. scrcpy can technically start while the device is
// locked, but the user cannot interact with the mirrored screen reliably.
func (c *Client) IsUnlocked(serial string) (bool, error) {
	power, err := c.Shell(serial, 5*time.Second, "dumpsys power")
	if err != nil {
		return false, err
	}
	window, err := c.Shell(serial, 5*time.Second, "dumpsys window")
	if err != nil {
		return false, err
	}
	return parseUnlockedState(power, window), nil
}

func parseUnlockedState(power, window string) bool {
	awake := false
	for _, line := range strings.Split(power, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "mWakefulness=") {
			awake = strings.TrimPrefix(line, "mWakefulness=") == "Awake"
			break
		}
	}
	if !awake {
		return false
	}

	// These fields are emitted by different Android releases. Treat an
	// explicit keyguard indication as locked; absence of all fields is kept
	// permissive for vendor builds that omit the window policy dump details.
	for _, line := range strings.Split(window, "\n") {
		line = strings.TrimSpace(line)
		for _, field := range []string{"isKeyguardShowing", "mShowingLockscreen", "mDreamingLockscreen"} {
			if strings.HasPrefix(line, field+"=") && strings.TrimPrefix(line, field+"=") == "true" {
				return false
			}
		}
	}
	return true
}

// PushBytes writes data to a temporary local file and pushes it. adb push does
// not consistently support stdin across platform-tools versions.
func (c *Client) PushBytes(serial, remotePath string, r io.Reader) error {
	tmp, err := os.CreateTemp("", "mugi-push-*")
	if err != nil {
		return fmt.Errorf("create upload temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return fmt.Errorf("stage upload: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close upload temp file: %w", err)
	}

	cmd := hostexec.Command(c.Bin, "-s", serial, "push", tmpPath, remotePath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("push failed: %v: %s", err, stderr.String())
	}
	return nil
}

// Install installs an APK that has already been pushed to the device.
func (c *Client) Install(serial, remoteApk string) (string, error) {
	stdout, stderr, err := c.run(5*time.Minute, "-s", serial, "shell", "pm install -r "+shellQuote(remoteApk))
	return installResult(stdout, stderr, err)
}

// Package Manager writes failures to stderr on some Android/ADB versions. Keep
// both streams so callers can surface the actual INSTALL_FAILED_* reason
// instead of only an opaque "exit status 255".
func installResult(stdout, stderr string, err error) (string, error) {
	parts := make([]string, 0, 2)
	if text := strings.TrimSpace(stdout); text != "" {
		parts = append(parts, text)
	}
	if text := strings.TrimSpace(stderr); text != "" {
		parts = append(parts, text)
	}
	output := strings.Join(parts, "\n")
	if err == nil {
		return output, nil
	}
	if output == "" {
		return "", fmt.Errorf("安装命令失败: %w（设备未返回具体原因；请检查连接、手机存储空间及手机上的安装确认提示）", err)
	}
	return output, fmt.Errorf("安装失败: %w: %s", err, output)
}

// Pull streams a remote file to w using exec-out (binary safe).
func (c *Client) Pull(serial, remotePath string, w io.Writer) error {
	cmd := hostexec.Command(c.Bin, "-s", serial, "exec-out", "cat -- "+shellQuote(remotePath))
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pull failed: %v: %s", err, stderr.String())
	}
	return nil
}

// ListFiles lists a remote directory.
func (c *Client) ListFiles(serial, path string) ([]FileInfo, error) {
	// stat -c is not available on all toybox builds; use ls -l parsing.
	quoted := shellQuote(path)
	out, err := c.Shell(serial, 15*time.Second, fmt.Sprintf("ls -l --time-style=+%%s %s 2>/dev/null || ls -l %s", quoted, quoted))
	if err != nil {
		return nil, err
	}
	files := make([]FileInfo, 0)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		if len(fields) < 6 || strings.HasPrefix(line, "total") {
			continue
		}
		fi := FileInfo{IsDir: strings.HasPrefix(fields[0], "d")}
		nameStart := len(fields) - 1
		if len(fields) >= 7 {
			// With --time-style=+%s: perms links owner group size epoch name...
			if mtime, parseErr := strconv.ParseInt(fields[5], 10, 64); parseErr == nil {
				fi.Mtime = mtime
				nameStart = 6
			} else if len(fields) >= 8 {
				// Common toybox fallback: perms links owner group size date time name...
				nameStart = 7
			}
		}
		fi.Name = strings.Join(fields[nameStart:], " ")
		if fi.Name == "." || fi.Name == ".." {
			continue
		}
		// Find the size field: first pure-number field after permissions+links
		for i := 2; i < len(fields)-1; i++ {
			if n, err := strconv.ParseInt(fields[i], 10, 64); err == nil && n >= 0 {
				fi.Size = n
				break
			}
		}
		files = append(files, fi)
	}
	return files, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (c *Client) runFileCommand(serial string, command string) error {
	out, err := c.Shell(serial, 20*time.Second, command+" 2>&1")
	if err != nil {
		return fmt.Errorf("file operation failed: %w: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// CreateDirectory creates one remote directory and fails when it already exists.
func (c *Client) CreateDirectory(serial, remotePath string) error {
	return c.runFileCommand(serial, "mkdir -- "+shellQuote(remotePath))
}

// CopyFile recursively copies a remote file or directory without replacing an existing item.
func (c *Client) CopyFile(serial, oldPath, newPath string) error {
	oldQuoted, newQuoted := shellQuote(oldPath), shellQuote(newPath)
	command := fmt.Sprintf("if [ -e %s ] || [ -L %s ]; then echo 'destination already exists'; exit 1; fi; cp -R -- %s %s", newQuoted, newQuoted, oldQuoted, newQuoted)
	out, err := c.Shell(serial, 2*time.Minute, command+" 2>&1")
	if err != nil {
		return fmt.Errorf("file operation failed: %w: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// RenameFile renames a remote file or directory without replacing an existing item.
func (c *Client) RenameFile(serial, oldPath, newPath string) error {
	oldQuoted, newQuoted := shellQuote(oldPath), shellQuote(newPath)
	command := fmt.Sprintf("if [ -e %s ]; then echo 'destination already exists'; exit 1; fi; mv -- %s %s", newQuoted, oldQuoted, newQuoted)
	return c.runFileCommand(serial, command)
}

// DeleteFile recursively removes one remote file or directory.
func (c *Client) DeleteFile(serial, remotePath string) error {
	return c.runFileCommand(serial, "rm -rf -- "+shellQuote(remotePath))
}

// Apps returns launchable apps. It prefers the scrcpy server list_apps output
// (real app names), falling back to pm list packages.
func (c *Client) Apps(serial string) ([]App, error) {
	apps, err := c.appsViaScrcpyServer(serial)
	if err == nil && len(apps) > 0 {
		return apps, nil
	}
	return c.appsViaPM(serial)
}

// appListLineRe parses lines produced by LogUtils.buildAppListMessage, e.g.:
// " * Firefox                      org.mozilla.firefox"
var (
	appListLineRe = regexp.MustCompile(`^\s*([*-])\s+(.+?)\s+([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)+)\s*$`)
	appNameOnlyRe = regexp.MustCompile(`^\s*([*-])\s+(.+?)\s*$`)
	packageOnlyRe = regexp.MustCompile(`^\s*([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)+)\s*$`)
)

func (c *Client) appsViaScrcpyServer(serial string) ([]App, error) {
	cmd := hostexec.Command(c.Bin, "-s", serial, "shell",
		"CLASSPATH=/data/local/tmp/mugi/scrcpy-server app_process / com.genymobile.scrcpy.Server 4.1 list_apps=true cleanup=false log_level=info")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("list_apps timeout")
	}

	launchable, _ := c.launchablePackages(serial)
	apps := parseAppListOutput(out.String(), launchable)
	if len(apps) == 0 {
		return nil, fmt.Errorf("no apps parsed from server output")
	}
	return apps, nil
}

func parseAppListOutput(output string, launchable map[string]bool) []App {
	apps := make([]App, 0)
	var pendingName string
	var pendingSystem bool
	sc := bufio.NewScanner(strings.NewReader(output))
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if pendingName != "" {
			if m := packageOnlyRe.FindStringSubmatch(line); m != nil {
				pkg := m[1]
				apps = append(apps, App{Name: pendingName, Package: pkg, System: pendingSystem, Launchable: launchable[pkg]})
				pendingName = ""
				continue
			}
			pendingName = ""
		}
		if m := appListLineRe.FindStringSubmatch(line); m != nil {
			name, pkg := strings.TrimSpace(m[2]), m[3]
			apps = append(apps, App{Name: name, Package: pkg, System: m[1] == "*", Launchable: launchable[pkg]})
			continue
		}
		if m := appNameOnlyRe.FindStringSubmatch(line); m != nil {
			pendingSystem = m[1] == "*"
			pendingName = strings.TrimSpace(m[2])
		}
	}
	return apps
}

func (c *Client) launchablePackages(serial string) (map[string]bool, error) {
	out, err := c.Shell(serial, 20*time.Second,
		"cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null")
	set := map[string]bool{}
	if err != nil {
		return set, err
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, "/"); i > 0 && !strings.Contains(line, " ") {
			set[line[:i]] = true
		}
	}
	return set, nil
}

func (c *Client) appsViaPM(serial string) ([]App, error) {
	launchable, _ := c.launchablePackages(serial)
	out, err := c.Shell(serial, 20*time.Second, "pm list packages")
	if err != nil {
		return nil, err
	}
	apps := make([]App, 0)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		pkg := strings.TrimPrefix(line, "package:")
		if pkg == line || pkg == "" {
			continue
		}
		name := pkg
		if i := strings.LastIndex(pkg, "."); i >= 0 && i < len(pkg)-1 {
			name = pkg[i+1:]
		}
		apps = append(apps, App{Name: name, Package: pkg, Launchable: launchable[pkg]})
	}
	return apps, nil
}

// Cmd runs an arbitrary adb command with a timeout and returns stdout/stderr.
func (c *Client) Cmd(timeout time.Duration, args ...string) (string, string, error) {
	return c.run(timeout, args...)
}
