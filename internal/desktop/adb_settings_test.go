package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func fakeADB(t *testing.T, script string, mode os.FileMode) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a Unix shell script")
	}
	path := filepath.Join(t.TempDir(), "platform tools", "adb")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func adbSettingsRequest(t *testing.T, handler http.Handler, method, body string) (int, adbSettingsStatus) {
	t.Helper()
	request := httptest.NewRequest(method, adbSettingsPath, strings.NewReader(body))
	request.Header.Set("Origin", Origin)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var status adbSettingsStatus
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, status
}

func TestADBSettingsPersistAndRequireRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := NewADBSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.SetStartupResult("", errors.New("cannot find adb"))
	handler := s.Handler(http.NotFoundHandler())
	code, status := adbSettingsRequest(t, handler, http.MethodGet, "")
	if code != http.StatusOK || status.ADBPath != "" || status.RestartRequired || status.StartupError != "cannot find adb" {
		t.Fatalf("unexpected initial status: %d %+v", code, status)
	}
	path := fakeADB(t, `[ "$1" = version ] || exit 2
echo 'Android Debug Bridge version 1.0.41'`, 0o700)
	body, _ := json.Marshal(adbPreferences{ADBPath: "  " + path + "  "})
	code, status = adbSettingsRequest(t, handler, http.MethodPut, string(body))
	if code != http.StatusOK || status.ADBPath != path || !status.RestartRequired || status.ActivePath != "" {
		t.Fatalf("unexpected saved status: %d %+v", code, status)
	}
	info, err := os.Stat(filepath.Join(dir, "desktop.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("config permissions: %v", info.Mode())
	}
	loaded, err := NewADBSettings(dir)
	if err != nil || loaded.Path() != path {
		t.Fatalf("config not persisted: %v", err)
	}
	loaded.SetStartupResult(path, nil)
	code, status = adbSettingsRequest(t, loaded.Handler(http.NotFoundHandler()), http.MethodGet, "")
	if code != http.StatusOK || status.RestartRequired || status.ActivePath != path || status.StartupError != "" {
		t.Fatalf("unexpected restarted status: %d %+v", code, status)
	}
	code, status = adbSettingsRequest(t, loaded.Handler(http.NotFoundHandler()), http.MethodPut, `{"adbPath":""}`)
	if code != http.StatusOK || status.ADBPath != "" || !status.RestartRequired || status.ActivePath != path {
		t.Fatalf("clearing override changed running backend: %d %+v", code, status)
	}
	cleared, err := NewADBSettings(dir)
	if err != nil || cleared.Path() != "" {
		t.Fatalf("clear not persisted: %v", err)
	}
}

func TestValidateADBPath(t *testing.T) {
	valid := fakeADB(t, "echo 'Android Debug Bridge version 1.0.41'", 0o700)
	wrong := fakeADB(t, "echo 'not adb'", 0o700)
	failed := fakeADB(t, "echo 'bad executable' >&2; exit 1", 0o700)
	nonExecutable := fakeADB(t, "echo 'Android Debug Bridge version 1.0.41'", 0o600)
	for _, tc := range []struct {
		name, path string
		valid      bool
	}{
		{"automatic", "  ", true},
		{"valid with spaces", valid, true},
		{"command name", "adb", false},
		{"relative path", "./adb", false},
		{"directory", filepath.Dir(valid), false},
		{"missing file", filepath.Join(t.TempDir(), "adb"), false},
		{"not executable", nonExecutable, false},
		{"wrong binary", wrong, false},
		{"failed version", failed, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateADBPath(context.Background(), tc.path)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	t.Setenv("HOME", filepath.Dir(valid))
	if path, err := validateADBPath(context.Background(), "~/adb"); err != nil || path != valid {
		t.Fatalf("home path was not expanded: %q %v", path, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := validateADBPath(ctx, valid); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation was not respected: %v", err)
	}
	slow := fakeADB(t, "exec /bin/sleep 30", 0o700)
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := validateADBPath(ctx, slow); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout was not respected: %v", err)
	}
}

func TestADBSettingsRejectInvalidRequestsAndPreserveConfig(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "desktop.json")
	original := `{"adbPath":"/original/adb"}`
	if err := os.WriteFile(file, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewADBSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.Handler(http.NotFoundHandler())
	for _, body := range []string{
		`{`, `{}`, `{"adbPath":null}`, `{"adbPath":1}`, `{"adbPath":"adb"}`,
		`{"adbPath":""} {}`, `{"adbPath":""} trailing`,
		`{"adbPath":"","unexpected":true}`, `{"adbPath":"` + strings.Repeat("a", 17*1024) + `"}`,
	} {
		code, _ := adbSettingsRequest(t, handler, http.MethodPut, body)
		if code != http.StatusBadRequest {
			t.Fatalf("invalid request returned %d", code)
		}
	}
	request := httptest.NewRequest(http.MethodPut, adbSettingsPath, strings.NewReader(`{"adbPath":""}`))
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("foreign origin returned %d", response.Code)
	}
	code, _ := adbSettingsRequest(t, handler, http.MethodPost, "")
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported method returned %d", code)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != original || s.Path() != "/original/adb" {
		t.Fatalf("invalid request changed config: %s %v", data, err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/devices", nil))
	if response.Code != http.StatusNotFound {
		t.Fatal("ordinary routes were intercepted")
	}
}

func TestADBSettingsSaveFailurePreservesMemory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "desktop.json"), []byte(`{"adbPath":"/original/adb"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewADBSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.file = filepath.Join(t.TempDir(), "missing", "desktop.json")
	code, _ := adbSettingsRequest(t, s.Handler(http.NotFoundHandler()), http.MethodPut, `{"adbPath":""}`)
	if code != http.StatusInternalServerError || s.Path() != "/original/adb" {
		t.Fatalf("unexpected failed save: %d %q", code, s.Path())
	}
}

func TestADBSettingsNotExposedByBridge(t *testing.T) {
	s, err := NewADBSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bridge, err := NewBridge(s.Handler(http.NotFoundHandler()))
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		request, _ := http.NewRequest(method, bridge.UploadBase+adbSettingsPath, strings.NewReader(`{"adbPath":""}`))
		request.Header.Set("Origin", Origin)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("settings exposed over TCP: %d", response.StatusCode)
		}
	}
}
