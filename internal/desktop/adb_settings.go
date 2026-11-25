package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"mugi/internal/hostexec"
)

const adbSettingsPath = "/api/desktop/adb"

type adbPreferences struct {
	ADBPath string `json:"adbPath"`
}

// ADBSettings persists a desktop-only executable override. Changes take effect
// on restart so existing sessions, shells and Logcat processes are not disrupted.
type ADBSettings struct {
	mu           sync.Mutex
	file         string
	preferences  adbPreferences
	startupPath  string
	activePath   string
	startupError string
}

type adbSettingsStatus struct {
	ADBPath         string `json:"adbPath"`
	ActivePath      string `json:"activePath"`
	StartupError    string `json:"startupError"`
	RestartRequired bool   `json:"restartRequired"`
}

func NewADBSettings(configDir string) (*ADBSettings, error) {
	s := &ADBSettings{file: filepath.Join(configDir, "desktop.json")}
	data, err := os.ReadFile(s.file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("读取桌面配置失败：%w", err)
	}
	if err == nil {
		if err := json.Unmarshal(data, &s.preferences); err != nil {
			return nil, fmt.Errorf("读取桌面配置失败：%w", err)
		}
	}
	s.startupPath = s.preferences.ADBPath
	return s, nil
}

// Path is the saved override, which takes precedence over ADB and bundled tools.
func (s *ADBSettings) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.preferences.ADBPath
}

func (s *ADBSettings) SetStartupResult(path string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activePath = path
	if err != nil {
		s.startupError = err.Error()
	} else {
		s.startupError = ""
	}
}

func (s *ADBSettings) status() adbSettingsStatus {
	return adbSettingsStatus{
		ADBPath:         s.preferences.ADBPath,
		ActivePath:      s.activePath,
		StartupError:    s.startupError,
		RestartRequired: s.preferences.ADBPath != s.startupPath,
	}
}

func validateADBPath(ctx context.Context, path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil // Clearing the override restores automatic discovery.
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("请输入 adb 可执行文件的绝对路径，而不是目录或命令名")
	}
	bin, err := exec.LookPath(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("ADB 路径不可用，请检查文件是否存在且具有执行权限：%w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := hostexec.CommandContext(ctx, bin, "version")
	cmd.WaitDelay = time.Second
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", fmt.Errorf("校验 ADB 超时或已取消：%w", ctx.Err())
	}
	if err != nil {
		return "", fmt.Errorf("运行 adb version 失败：%w：%s", err, strings.TrimSpace(string(output)))
	}
	if !strings.Contains(string(output), "Android Debug Bridge version") {
		return "", errors.New("所选文件未返回有效的 adb version 信息，请选择 Android Platform Tools 中的 adb")
	}
	return bin, nil
}

func (s *ADBSettings) save(path string) error {
	data, err := json.MarshalIndent(adbPreferences{ADBPath: path}, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.file), ".desktop-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(append(data, '\n'))
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), s.file); err != nil {
		return err
	}
	s.preferences.ADBPath = path
	return nil
}

// Handler must only wrap the native in-process router. The bridge deliberately
// does not expose this endpoint on its loopback upload/WebSocket listener.
func (s *ADBSettings) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != adbSettingsPath {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		fail := func(status int, err error) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isAllowedOrigin(origin) {
			fail(http.StatusForbidden, errors.New("仅桌面应用可修改 ADB 配置"))
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(s.status())
		case http.MethodPut:
			var body struct {
				ADBPath *string `json:"adbPath"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&body); err != nil || body.ADBPath == nil {
				fail(http.StatusBadRequest, errors.New("请输入 adbPath 字符串；空字符串表示自动查找"))
				return
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				fail(http.StatusBadRequest, errors.New("请求必须是单个 JSON 对象"))
				return
			}
			path, err := validateADBPath(r.Context(), *body.ADBPath)
			if err != nil {
				fail(http.StatusBadRequest, err)
				return
			}
			if err := s.save(path); err != nil {
				fail(http.StatusInternalServerError, fmt.Errorf("保存 ADB 配置失败：%w", err))
				return
			}
			_ = json.NewEncoder(w).Encode(s.status())
		default:
			w.Header().Set("Allow", "GET, PUT")
			fail(http.StatusMethodNotAllowed, errors.New("不支持的请求方法"))
		}
	})
}
