package adb

import (
	"errors"
	"strings"
	"testing"
)

func TestParseAppListOutput(t *testing.T) {
	output := `INFO: List of apps:
 * Settings                       com.android.settings
 - Firefox                        org.mozilla.firefox
 - An application name longer than thirty characters
                                  com.example.longname
`
	launchable := map[string]bool{
		"com.android.settings": true,
		"org.mozilla.firefox":  true,
		"com.example.longname": true,
	}
	apps := parseAppListOutput(output, launchable)
	if len(apps) != 3 {
		t.Fatalf("got %d apps: %#v", len(apps), apps)
	}
	if !apps[0].System || apps[0].Name != "Settings" || apps[0].Package != "com.android.settings" {
		t.Fatalf("bad system app: %#v", apps[0])
	}
	if apps[1].System || apps[1].Name != "Firefox" || !apps[1].Launchable {
		t.Fatalf("bad user app: %#v", apps[1])
	}
	if apps[2].Name != "An application name longer than thirty characters" || apps[2].Package != "com.example.longname" {
		t.Fatalf("bad wrapped app: %#v", apps[2])
	}
}

func TestParseUnlockedState(t *testing.T) {
	powerAwake := "mWakefulness=Awake\n"
	powerAsleep := "mWakefulness=Asleep\n"
	if !parseUnlockedState(powerAwake, "isKeyguardShowing=false\n") {
		t.Fatal("expected awake device without keyguard to be unlocked")
	}
	for _, window := range []string{
		"isKeyguardShowing=true\n",
		"mShowingLockscreen=true\n",
		"mDreamingLockscreen=true\n",
	} {
		if parseUnlockedState(powerAwake, window) {
			t.Fatalf("expected keyguard state to be locked: %q", window)
		}
	}
	if parseUnlockedState(powerAsleep, "isKeyguardShowing=false\n") {
		t.Fatal("expected asleep device to require unlocking")
	}
}

func TestParseDisplaySize(t *testing.T) {
	output := "Physical size: 1080x2400\nOverride size: 900x2000\n"
	width, height := parseDisplaySize(output)
	if width != 1080 || height != 2400 {
		t.Fatalf("unexpected display size: %dx%d", width, height)
	}
	width, height = parseDisplaySize("Override size: 900x1600\n")
	if width != 0 || height != 0 {
		t.Fatalf("expected missing physical size to be ignored, got %dx%d", width, height)
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("/sdcard/照片/it's here.txt"); got != "'/sdcard/照片/it'\"'\"'s here.txt'" {
		t.Fatalf("unexpected shell quote: %q", got)
	}
}

func TestInstallResultPreservesFailureDetails(t *testing.T) {
	processErr := errors.New("exit status 255")
	output, err := installResult("", "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n", processErr)
	if output != "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" {
		t.Fatalf("unexpected output: %q", output)
	}
	if err == nil || !strings.Contains(err.Error(), "INSTALL_FAILED_INSUFFICIENT_STORAGE") || !errors.Is(err, processErr) {
		t.Fatalf("failure detail or process error was lost: %v", err)
	}
}

func TestInstallResultExplainsEmptyFailure(t *testing.T) {
	_, err := installResult("", "", errors.New("exit status 255"))
	if err == nil || !strings.Contains(err.Error(), "设备未返回具体原因") {
		t.Fatalf("empty failure was not explained: %v", err)
	}
}

func TestInstallResultCombinesSuccessStreams(t *testing.T) {
	output, err := installResult("Success\n", "warning\n", nil)
	if err != nil || output != "Success\nwarning" {
		t.Fatalf("unexpected result: %q, %v", output, err)
	}
}
