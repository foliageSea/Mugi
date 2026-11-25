section() { printf '\n__%s__\n' "$1"; }
section PROPERTIES
getprop
section BATTERY
dumpsys battery 2>/dev/null
section STORAGE
df -k /data /sdcard 2>/dev/null
section DISPLAY
wm size 2>/dev/null
wm density 2>/dev/null
section NETWORK
ip -o -4 addr show scope global 2>/dev/null
section UPTIME
cat /proc/uptime 2>/dev/null
section FOREGROUND
dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | head -n 4
section SECURITY
id
getenforce 2>/dev/null
section SETTINGS
settings get system screen_brightness
settings get system screen_brightness_mode
settings get global stay_on_while_plugged_in
settings get system accelerometer_rotation
section END
