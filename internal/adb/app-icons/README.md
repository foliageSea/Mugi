# Android app icon helper

mugi embeds the checked-in [raw DEX](../assets/app-icons.dex) in Go and imports the same artifact in Vite. Normal mugi builds do not need the Android SDK.

## Rebuild

Install JDK 17 and the Android SDK packages `platforms;android-35` and
`build-tools;35.0.0`. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to that SDK and
put `java` and `javac` on your PATH. From the repository root, run:

```sh
./internal/adb/app-icons/build.sh
```

Include the regenerated [DEX](../assets/app-icons.dex) with source changes. The
script invokes D8 directly (minimum API 23) and writes a raw DEX, not a ZIP or APK.

## Device protocol

Copy the DEX to a shell-readable temporary path under `/data/local/tmp` and make
it read-only (`chmod 444`) before executing it. No APK installation or root access
is needed. Run this over a binary-safe shell with no PTY (e.g. `adb shell -T`):

```sh
CLASSPATH=/data/local/tmp/<unique-path>/helper.dex app_process /system/bin dev.mugi.icons.Main com.android.settings
```

Pass exactly one Android package ID. On success, stdout is just a 96 × 96 PNG and
the exit status is 0. An unknown package or unavailable icon exits 1; invalid
arguments exit 2. Both write diagnostics to stderr with no stdout. A client
should fall back to a generic icon on either failure (or if the device cannot run
the helper). Remove only the temporary file and directory created for the helper.

The helper runs as the ADB shell UID and queries packages for the current
foreground Android user (like `pm list packages --user current`). It does not
switch users or search other profiles. Android loads the application's declared
drawable and draws it into an ARGB bitmap, so PNG, vector, and adaptive drawables
use the framework renderer. The helper uses internal Android APIs to bootstrap
a user-scoped framework context because `app_process` does not start an installed
application. The protocol was verified on Android 17 / API 37.
