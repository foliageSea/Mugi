package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

type stubBackend struct{}

func localRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.RemoteAddr = "192.168.1.10:12345"
	return req
}

func (stubBackend) Devices() ([]adb.Device, error) {
	return []adb.Device{{Serial: "test", State: "device", Model: "Test_Device"}}, nil
}

type recordingFileBackend struct {
	stubBackend
	listed  string
	created string
	copied  [][2]string
	renamed [2]string
	deleted string
}

type recordingInstallBackend struct {
	stubBackend
	payload string
}

type recordingSessionBackend struct {
	stubBackend
	started int
}

func (b *recordingSessionBackend) StartSession(serial string, opts scrcpy.SessionOptions) (*scrcpy.Session, error) {
	b.started++
	return &scrcpy.Session{
		ID:     fmt.Sprintf("session-%d", b.started),
		Serial: serial,
		Opts:   opts,
	}, nil
}

func (b *recordingInstallBackend) Install(_ string, apk io.Reader) (string, error) {
	data, err := io.ReadAll(apk)
	if err != nil {
		return "", err
	}
	b.payload = string(data)
	return "Success", nil
}

func apkRequest(t *testing.T, filename string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("apk payload")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := localRequest(http.MethodPost, "/api/devices/test/install", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestInstallAPKRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingInstallBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))

	req := apkRequest(t, "demo.APK")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusOK || backend.payload != "apk payload" {
		t.Fatalf("status %d, payload %q, body %s", response.Code, backend.payload, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"output":"Success"`) {
		t.Fatalf("unexpected response %s", response.Body.String())
	}

	req = apkRequest(t, "not-an-apk.txt")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("non-APK status %d, body %s", response.Code, response.Body.String())
	}
}

func (b *recordingFileBackend) ListFiles(_ string, path string) ([]adb.FileInfo, error) {
	b.listed = path
	return nil, nil
}

func (b *recordingFileBackend) CreateDirectory(_ string, path string) error {
	b.created = path
	return nil
}

func (b *recordingFileBackend) CopyFile(_ string, oldPath, newPath string) error {
	b.copied = append(b.copied, [2]string{oldPath, newPath})
	return nil
}

func (b *recordingFileBackend) RenameFile(_ string, oldPath, newPath string) error {
	b.renamed = [2]string{oldPath, newPath}
	return nil
}

func (b *recordingFileBackend) DeleteFile(_ string, path string) error {
	b.deleted = path
	return nil
}

func TestFileMutationRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingFileBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))

	tests := []struct {
		method string
		path   string
		body   string
		status int
	}{
		{http.MethodPost, "/api/devices/test/directories", `{"path":"/sdcard/项目 资料"}`, http.StatusCreated},
		{http.MethodPatch, "/api/devices/test/files", `{"path":"/sdcard/项目 资料","name":"归档's"}`, http.StatusOK},
		{http.MethodDelete, "/api/devices/test/files", `{"path":"/sdcard/归档's"}`, http.StatusOK},
	}
	for _, tc := range tests {
		req := localRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != tc.status {
			t.Fatalf("%s %s: status %d, body %s", tc.method, tc.path, res.Code, res.Body.String())
		}
	}

	if backend.created != "/sdcard/项目 资料" {
		t.Fatalf("created path %q", backend.created)
	}
	if backend.renamed != [2]string{"/sdcard/项目 资料", "/sdcard/归档's"} {
		t.Fatalf("renamed paths %#v", backend.renamed)
	}
	if backend.deleted != "/sdcard/归档's" {
		t.Fatalf("deleted path %q", backend.deleted)
	}
}

func TestFileMutationProtectsStorageRoot(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingFileBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))
	req := localRequest(http.MethodDelete, "/api/devices/test/files", strings.NewReader(`{"path":"/sdcard"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest || backend.deleted != "" {
		t.Fatalf("status %d, deleted %q", res.Code, backend.deleted)
	}
}

func TestBatchFileTransferRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingFileBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))

	copyRequest := localRequest(http.MethodPost, "/api/devices/test/files/transfer", strings.NewReader(
		`{"paths":["/sdcard/Download/a.txt","/sdcard/Download/资料"],"destination":"/sdcard/Documents","mode":"copy"}`,
	))
	copyRequest.Header.Set("Content-Type", "application/json")
	copyResponse := httptest.NewRecorder()
	router.ServeHTTP(copyResponse, copyRequest)
	if copyResponse.Code != http.StatusOK {
		t.Fatalf("copy status %d, body %s", copyResponse.Code, copyResponse.Body.String())
	}
	expectedCopies := [][2]string{
		{"/sdcard/Download/a.txt", "/sdcard/Documents/a.txt"},
		{"/sdcard/Download/资料", "/sdcard/Documents/资料"},
	}
	if !reflect.DeepEqual(backend.copied, expectedCopies) {
		t.Fatalf("copied paths %#v", backend.copied)
	}

	moveRequest := localRequest(http.MethodPost, "/api/devices/test/files/transfer", strings.NewReader(
		`{"paths":["/sdcard/Documents/a.txt"],"destination":"/sdcard/Download","mode":"move"}`,
	))
	moveRequest.Header.Set("Content-Type", "application/json")
	moveResponse := httptest.NewRecorder()
	router.ServeHTTP(moveResponse, moveRequest)
	if moveResponse.Code != http.StatusOK || backend.renamed != [2]string{"/sdcard/Documents/a.txt", "/sdcard/Download/a.txt"} {
		t.Fatalf("move status %d, renamed %#v, body %s", moveResponse.Code, backend.renamed, moveResponse.Body.String())
	}
}

func TestFileListingProtectsStorageRoot(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingFileBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))

	root := httptest.NewRecorder()
	router.ServeHTTP(root, localRequest(
		http.MethodGet,
		"/api/devices/test/files?path=%2Fsdcard",
		nil,
	))
	if root.Code != http.StatusBadRequest || backend.listed != "" {
		t.Fatalf("root status %d, listed %q", root.Code, backend.listed)
	}

	defaultPath := httptest.NewRecorder()
	router.ServeHTTP(defaultPath, localRequest(
		http.MethodGet,
		"/api/devices/test/files",
		nil,
	))
	if defaultPath.Code != http.StatusOK || backend.listed != "/sdcard/Download" {
		t.Fatalf("default status %d, listed %q", defaultPath.Code, backend.listed)
	}
}
func (stubBackend) IsUnlocked(string) (bool, error)     { return true, nil }
func (stubBackend) Pair(string, int, string) error      { return nil }
func (stubBackend) Connect(string, int) (string, error) { return "test", nil }
func (stubBackend) Disconnect(string) error             { panic("unexpected device disconnect") }
func (stubBackend) Apps(string) ([]adb.App, error)      { return nil, nil }
func (stubBackend) StartSession(string, scrcpy.SessionOptions) (*scrcpy.Session, error) {
	panic("StartSession must not be called for invalid input")
}
func (stubBackend) Push(string, string, io.Reader) error             { return nil }
func (stubBackend) Install(string, io.Reader) (string, error)        { return "Success", nil }
func (stubBackend) ListFiles(string, string) ([]adb.FileInfo, error) { return nil, nil }
func (stubBackend) Pull(string, string, io.Writer) error             { return nil }
func (stubBackend) CreateDirectory(string, string) error             { return nil }
func (stubBackend) CopyFile(string, string, string) error            { return nil }
func (stubBackend) RenameFile(string, string, string) error          { return nil }
func (stubBackend) DeleteFile(string, string) error                  { return nil }

func testRouter(t *testing.T) http.Handler {
	t.Helper()
	gin.SetMode(gin.TestMode)
	assets := fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<h1>mugi</h1>")},
		"assets/app.css": &fstest.MapFile{Data: []byte("body{}")},
		"assets/app.js":  &fstest.MapFile{Data: []byte("export {}")},
	}
	var webFS fs.FS = assets
	return New(stubBackend{}, scrcpy.NewManager()).Router(http.FS(webFS))
}

func TestRouterServesAPIAndAssets(t *testing.T) {
	router := testRouter(t)
	for _, tc := range []struct {
		path        string
		contentType string
		body        string
	}{
		{"/", "text/html", "mugi"},
		{"/assets/app.css", "text/css", "body{}"},
		{"/api/devices", "application/json", `"serial":"test"`},
		{"/api/devices/test/unlock-status", "application/json", `"unlocked":true`},
	} {
		req := localRequest(http.MethodGet, tc.path, nil)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d, body %s", tc.path, res.Code, res.Body.String())
		}
		if !strings.Contains(res.Header().Get("Content-Type"), tc.contentType) {
			t.Errorf("GET %s: content-type %q", tc.path, res.Header().Get("Content-Type"))
		}
		if !strings.Contains(res.Body.String(), tc.body) {
			t.Errorf("GET %s: body %q does not contain %q", tc.path, res.Body.String(), tc.body)
		}
	}
}

func TestExternalAccessOnlyAllowsCapabilities(t *testing.T) {
	router := testRouter(t)

	capabilities := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/capabilities", nil)
	request.RemoteAddr = "8.8.8.8:12345"
	router.ServeHTTP(capabilities, request)
	if capabilities.Code != http.StatusOK || !strings.Contains(capabilities.Body.String(), `"adbAllowed":false`) {
		t.Fatalf("capabilities: status %d, body %s", capabilities.Code, capabilities.Body.String())
	}

	devices := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	request.RemoteAddr = "8.8.8.8:12345"
	router.ServeHTTP(devices, request)
	if devices.Code != http.StatusForbidden {
		t.Fatalf("devices: status %d, body %s", devices.Code, devices.Body.String())
	}
}

func TestForcedExternalAccessIgnoresPrivatePeer(t *testing.T) {
	router := NewWithAccessMode(stubBackend{}, scrcpy.NewManager(), AccessExternal).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))
	request := localRequest(http.MethodGet, "/api/devices", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forced external access: status %d, body %s", response.Code, response.Body.String())
	}
}

func TestPullFileUsesInlineMediaHeadersForPreview(t *testing.T) {
	router := testRouter(t)

	for _, tc := range []struct {
		path        string
		contentType string
	}{
		{"%2Fsdcard%2FPictures%2Fphoto.jpg", "image/jpeg"},
		{"%2Fsdcard%2FMovies%2Fclip.mp4", "video/mp4"},
	} {
		preview := httptest.NewRecorder()
		router.ServeHTTP(preview, localRequest(
			http.MethodGet,
			"/api/devices/test/pull?path="+tc.path+"&preview=1",
			nil,
		))
		if got := preview.Header().Get("Content-Type"); !strings.HasPrefix(got, tc.contentType) {
			t.Errorf("preview content-type %q, want %q", got, tc.contentType)
		}
		if got := preview.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline;") {
			t.Errorf("preview content-disposition %q", got)
		}
	}

	download := httptest.NewRecorder()
	router.ServeHTTP(download, localRequest(
		http.MethodGet,
		"/api/devices/test/pull?path=%2Fsdcard%2FPictures%2Fphoto.jpg",
		nil,
	))
	if got := download.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("download content-type %q", got)
	}
	if got := download.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment;") {
		t.Fatalf("download content-disposition %q", got)
	}
}

func TestStartSessionRejectsInvalidOptions(t *testing.T) {
	router := testRouter(t)
	req := localRequest(http.MethodPost, "/api/devices/test/sessions",
		strings.NewReader(`{"mode":"display","width":900,"height":99999,"startApp":"x'; rm -rf /"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status %d, body %s", res.Code, res.Body.String())
	}
}

func TestStartSessionMaxFps(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, body, wantFps string
		wantStatus          int
	}{
		{"omitted", `{}`, "", http.StatusOK},
		{"unlimited", `{"maxFps":0}`, "", http.StatusOK},
		{"minimum", `{"maxFps":1}`, "1", http.StatusOK},
		{"maximum", `{"maxFps":120}`, "120", http.StatusOK},
		{"negative", `{"maxFps":-1}`, "", http.StatusBadRequest},
		{"above maximum", `{"maxFps":121}`, "", http.StatusBadRequest},
		{"fraction", `{"maxFps":29.5}`, "", http.StatusBadRequest},
		{"string", `{"maxFps":"30"}`, "", http.StatusBadRequest},
		{"null", `{"maxFps":null}`, "", http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &recordingSessionBackend{}
			router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
				"index.html": &fstest.MapFile{Data: []byte("ok")},
			}))
			req := localRequest(http.MethodPost, "/api/devices/test/sessions", strings.NewReader(tc.body))
			res := httptest.NewRecorder()
			router.ServeHTTP(res, req)
			if res.Code != tc.wantStatus {
				t.Fatalf("status %d, want %d; body %s", res.Code, tc.wantStatus, res.Body)
			}
			if tc.wantStatus != http.StatusOK {
				if backend.started != 0 {
					t.Fatal("backend started a session with invalid maxFps")
				}
				return
			}
			var session struct {
				Opts map[string]json.RawMessage `json:"opts"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &session); err != nil {
				t.Fatal(err)
			}
			if got := string(session.Opts["maxFps"]); got != tc.wantFps {
				t.Errorf("response maxFps = %q, want %q (empty means omitted)", got, tc.wantFps)
			}
		})
	}
}

func TestStartSessionLimitsMirrorAndDuplicateApps(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingSessionBackend{}
	router := New(backend, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}))
	start := func(body string) *httptest.ResponseRecorder {
		req := localRequest(http.MethodPost, "/api/devices/test/sessions", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}

	if res := start(`{"mode":"mirror"}`); res.Code != http.StatusOK {
		t.Fatalf("first mirror status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"mirror"}`); res.Code != http.StatusConflict {
		t.Fatalf("second mirror status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"display","width":900,"height":1600,"startApp":"com.example.one"}`); res.Code != http.StatusOK {
		t.Fatalf("first app status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"display","width":1600,"height":900,"startApp":"com.example.one"}`); res.Code != http.StatusConflict {
		t.Fatalf("duplicate app status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"display","width":1600,"height":900,"startApp":"com.example.two"}`); res.Code != http.StatusOK {
		t.Fatalf("different app status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"display","width":900,"height":1600}`); res.Code != http.StatusOK {
		t.Fatalf("unspecified app status %d, body %s", res.Code, res.Body.String())
	}
	if res := start(`{"mode":"display","width":1600,"height":900}`); res.Code != http.StatusConflict {
		t.Fatalf("duplicate unspecified app status %d, body %s", res.Code, res.Body.String())
	}
	if backend.started != 4 {
		t.Fatalf("backend started %d sessions, want 4", backend.started)
	}
}

func TestSanitizeRemotePath(t *testing.T) {
	for _, input := range []string{"", "relative", "/sdcard/../data", "/data/local/tmp", "/sdcard/a\nb"} {
		if _, err := sanitizeRemotePath(input); err == nil {
			t.Errorf("expected %q to be rejected", input)
		}
	}
	if got, err := sanitizeRemotePath("/sdcard/Download/report 1.pdf"); err != nil || got != "/sdcard/Download/report 1.pdf" {
		t.Fatalf("valid path: got %q, err %v", got, err)
	}
	if got, err := sanitizeRemotePath("/sdcard/Download/report..final.pdf"); err != nil || got != "/sdcard/Download/report..final.pdf" {
		t.Fatalf("valid dotted path: got %q, err %v", got, err)
	}
}

type recordingReleaseBackend struct {
	stubBackend
	released int
}

func (b *recordingReleaseBackend) Release() error {
	b.released++
	return nil
}

func TestWebUSBReleaseRequiresIdleSessions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	backend := &recordingReleaseBackend{}
	manager := scrcpy.NewManager()
	router := New(backend, manager).Router(http.FS(fstest.MapFS{}))
	manager.Register(&scrcpy.Session{ID: "active"})
	res := httptest.NewRecorder()
	router.ServeHTTP(res, localRequest(http.MethodPost, "/api/adb/release", nil))
	if res.Code != http.StatusConflict || backend.released != 0 {
		t.Fatalf("active sessions: status %d, released %d", res.Code, backend.released)
	}
	manager.Remove("active")
	res = httptest.NewRecorder()
	router.ServeHTTP(res, localRequest(http.MethodPost, "/api/adb/release", nil))
	if res.Code != http.StatusOK || backend.released != 1 {
		t.Fatalf("idle sessions: status %d, released %d", res.Code, backend.released)
	}
}

func TestWebUSBPayloadAndUnsupportedRelease(t *testing.T) {
	router := testRouter(t)
	payload := httptest.NewRecorder()
	router.ServeHTTP(payload, localRequest(http.MethodGet, "/api/scrcpy-server", nil))
	if payload.Code != http.StatusOK || !bytes.Equal(payload.Body.Bytes(), scrcpy.ServerBinary()) {
		t.Fatal("browser payload must match the embedded scrcpy server")
	}
	release := httptest.NewRecorder()
	router.ServeHTTP(release, localRequest(http.MethodPost, "/api/adb/release", nil))
	if release.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported release: status %d", release.Code)
	}
}
