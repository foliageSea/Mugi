package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

type workbenchStub struct {
	stubBackend
	calls      int
	paths      []string
	opts       adb.InstallOptions
	failExport bool
}

func (b *workbenchStub) Workbench(_ context.Context, serial, op, value string) (string, error) {
	b.calls++
	return serial + ":" + op + ":" + value, nil
}
func (b *workbenchStub) Screenshot(context.Context, string) ([]byte, error) {
	b.calls++
	return []byte("\x89PNG\r\n\x1a\n\x00\xff"), nil
}
func (b *workbenchStub) ExportAPK(_ context.Context, _, _ string, _ int, w io.Writer) error {
	b.calls++
	if b.failExport {
		_, _ = w.Write([]byte("partial"))
		return errors.New("device disconnected")
	}
	_, err := w.Write([]byte("APK bytes"))
	return err
}
func (b *workbenchStub) InstallSet(_ context.Context, _ string, paths []string, opts adb.InstallOptions) (string, error) {
	b.calls++
	b.paths = append([]string(nil), paths...)
	b.opts = opts
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil || string(data) != "apk bytes" {
			return "", errors.New("missing staged APK")
		}
	}
	return "Success", nil
}
func workbenchRouter(b *workbenchStub) http.Handler {
	gin.SetMode(gin.TestMode)
	return New(b, scrcpy.NewManager()).Router(http.FS(fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}))
}
func TestWorkbenchRejectsInvalidAndExternalRequests(t *testing.T) {
	b := &workbenchStub{}
	router := workbenchRouter(b)
	for _, body := range []string{`{"operation":"shell","value":"id"}`, `{"operation":"app-clear","value":"x; reboot"}`, `{"operation":"brightness","value":"256"}`} {
		req := localRequest("POST", "/api/devices/test/workbench", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != 400 {
			t.Fatalf("status %d: %s", res.Code, res.Body.String())
		}
	}
	for _, endpoint := range []struct{ method, path string }{{"POST", "workbench"}, {"GET", "screenshot"}, {"GET", "packages/com.example/apk"}, {"POST", "install-set"}} {
		req := localRequest(endpoint.method, "/api/devices/test/"+endpoint.path, nil)
		req.RemoteAddr = "8.8.8.8:80"
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != 403 {
			t.Fatalf("external %s = %d", endpoint.path, res.Code)
		}
	}
	if b.calls != 0 {
		t.Fatal("invalid request reached device")
	}
	req := localRequest("POST", "/api/devices/test/workbench", strings.NewReader(`{"operation":"app-clear","value":"com.example.app"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "test:app-clear:com.example.app") {
		t.Fatal(res.Body.String())
	}
}
func TestScreenshotBinaryAndAPKExportFailure(t *testing.T) {
	b := &workbenchStub{}
	router := workbenchRouter(b)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, localRequest("GET", "/api/devices/test/screenshot", nil))
	if res.Code != 200 || res.Header().Get("Content-Type") != "image/png" || !bytes.Equal(res.Body.Bytes(), []byte("\x89PNG\r\n\x1a\n\x00\xff")) {
		t.Fatal("PNG was corrupted")
	}
	b.failExport = true
	res = httptest.NewRecorder()
	router.ServeHTTP(res, localRequest("GET", "/api/devices/test/packages/com.example/apk", nil))
	if res.Code != 502 || strings.Contains(res.Body.String(), "partial") {
		t.Fatal("partial APK reported as success")
	}
	b.failExport = false
	res = httptest.NewRecorder()
	router.ServeHTTP(res, localRequest("GET", "/api/devices/test/packages/com.example/apk", nil))
	if res.Code != 200 || res.Body.String() != "APK bytes" {
		t.Fatal(res.Body.String())
	}
}
func TestInstallSetStagesAndCleansSplitPackages(t *testing.T) {
	b := &workbenchStub{}
	router := workbenchRouter(b)
	var data bytes.Buffer
	w := multipart.NewWriter(&data)
	for _, name := range []string{"base.apk", "split_config.arm64.apk"} {
		part, _ := w.CreateFormFile("files", name)
		_, _ = part.Write([]byte("apk bytes"))
	}
	_ = w.WriteField("downgrade", "true")
	_ = w.WriteField("test", "true")
	_ = w.Close()
	req := localRequest("POST", "/api/devices/test/install-set", &data)
	req.Header.Set("Content-Type", w.FormDataContentType())
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != 200 || len(b.paths) != 2 || !b.opts.Downgrade || !b.opts.Test {
		t.Fatalf("%d %s", res.Code, res.Body.String())
	}
	for _, p := range b.paths {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("staged APK leaked")
		}
	}
}
