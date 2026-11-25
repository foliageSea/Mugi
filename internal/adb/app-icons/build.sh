#!/usr/bin/env bash
set -euo pipefail

helper_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -z "$sdk" ]]; then
  echo 'Set ANDROID_HOME to your Android SDK directory.' >&2
  exit 1
fi

android_jar="$sdk/platforms/android-35/android.jar"
d8="$sdk/build-tools/35.0.0/d8"
if [[ ! -f "$android_jar" || ! -x "$d8" ]]; then
  echo 'Install Android SDK packages platforms;android-35 and build-tools;35.0.0.' >&2
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/mugi-app-icons.XXXXXXXX")
[[ -d "$work" && "$work" == */mugi-app-icons.* ]]
trap 'rm -rf -- "${work:?}"' EXIT
mkdir -p "$work/classes" "$work/dex"
javac --release 8 -Xlint:all -classpath "$android_jar" -d "$work/classes" \
  "$helper_dir/src/dev/mugi/icons/Main.java"
"$d8" --release --lib "$android_jar" --min-api 23 --output "$work/dex" \
  "$work/classes/dev/mugi/icons/Main.class"
mkdir -p "$helper_dir/../assets"
cp -- "$work/dex/classes.dex" "$helper_dir/../assets/app-icons.dex"
