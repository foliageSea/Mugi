#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh --prepare vMAJOR.MINOR.PATCH[-prerelease]
  ./scripts/release.sh vMAJOR.MINOR.PATCH[-prerelease] [--notes TEXT | --notes-file FILE | --generate-notes]
  ./scripts/release.sh --help

Prepare updates the root npm package/lock versions and Windows app manifest
locally. Review, commit, and push the changes yourself, then run the publish
command. Publish requires a clean checkout at the tip of the same-named branch
on GitHub origin, and checks the version files in that commit.

Tags must be strict SemVer with a v prefix and no build metadata, at most 128
characters, with MAJOR, MINOR, and PATCH each at most 65535 (Windows limit).
Git does not permit tags ending in .lock.
Notes default to --generate-notes; use --notes-file - to read from stdin.
Prereleases are never marked latest. The script never creates a local tag or
moves an existing tag. If publishing fails after a remote tag was created,
you can retry with the same tag and commit.

Authenticate with gh auth login or set GH_TOKEN to a personal access token
with repository Contents write access. The script ignores GITHUB_TOKEN:
GitHub Actions' automatic token does not trigger release.published workflows.
Do not pass the automatic token through GH_TOKEN either.
EOF
}

fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

if [[ $# == 1 && $1 == --help ]]; then
  usage
  exit 0
fi
[[ $# -gt 0 ]] || { usage >&2; exit 2; }
prepare=false
if [[ $1 == --prepare ]]; then
  prepare=true
  shift
  [[ $# == 1 ]] || fail 'expected exactly one version after --prepare (see --help)'
fi

tag=$1
shift
number='(0|[1-9][0-9]*)'
semver="^v$number\\.$number\\.$number(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
[[ ${#tag} -le 128 && $tag =~ $semver ]] || fail 'expected vMAJOR.MINOR.PATCH[-prerelease] (strict SemVer, max 128 characters, no build metadata)'
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]} suffix=${BASH_REMATCH[4]}
if [[ ${suffix#-} =~ (^|\.)0[0-9]+(\.|$) ]]; then
  fail 'numeric prerelease identifiers cannot have leading zeros'
fi
[[ $tag != *.lock ]] || fail 'Git tag names cannot end in .lock'
for component in "$major" "$minor" "$patch"; do
  (( ${#component} <= 5 && component <= 65535 )) || fail 'version components must be at most 65535 for the Windows app manifest'
done
version=${tag#v}
windows_version=$major.$minor.$patch.0

notes=--generate-notes
case "${1---generate-notes}" in
  --generate-notes) [[ $# -le 1 ]] || fail 'use only one notes option (see --help)' ;;
  --notes|--notes-file)
    [[ $# == 2 && -n $2 ]] || fail "$1 requires one nonempty argument (see --help)"
    if [[ $1 == --notes-file && $2 != - ]]; then
      [[ -f $2 && -r $2 ]] || fail "cannot read notes file: $2"
    fi
    notes="$1=$2"
    ;;
  *) fail "unknown argument: $1 (see --help)" ;;
esac

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v node >/dev/null || fail 'Node.js is required to check or prepare version files'

sync_versions() {
  node - "$root" "$version" "$windows_version" "$prepare" "${1:-}" <<'NODE'
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [root, version, windowsVersion, prepare, commit] = process.argv.slice(2);
process.chdir(root);

const versionField = /^([ \t]{2}"version"[ \t]*:[ \t]*")[^"\r\n]+(")/m;
const lockRootVersion = /^(  "packages": \{\r?\n    "": \{\r?\n      "name": "[^"\r\n]+",\r?\n      "version": ")[^"\r\n]+(")/m;
const assemblyVersion = /(<assembly\s[^>]*>\s*<assemblyIdentity\b[^>]*\bversion=")[^"\r\n]+(")/;

function replace(file, text, pattern, value) {
  if (!pattern.test(text)) throw new Error(file + ': cannot locate version field');
  return text.replace(pattern, (_, before, after) => before + value + after);
}

function read(file) {
  return prepare === 'true' ? readFileSync(file, 'utf8') :
    execFileSync('git', ['show', commit + ':' + file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

try {
  const edits = ['package.json', 'package-lock.json', 'build/windows/app.manifest'].map((file) => {
    const before = read(file);
    let after;
    if (file.endsWith('.json')) {
      const expected = JSON.parse(before);
      if (typeof expected.version !== 'string') throw new Error(file + ': missing root version');
      expected.version = version;
      after = replace(file, before, versionField, version);
      if (file === 'package-lock.json') {
        if (typeof expected.packages?.['']?.version !== 'string') throw new Error(file + ': missing root package version');
        expected.packages[''].version = version;
        after = replace(file, after, lockRootVersion, version);
      }
      if (!isDeepStrictEqual(JSON.parse(after), expected)) throw new Error(file + ': unexpected version field layout');
    } else {
      after = replace(file, before, assemblyVersion, windowsVersion);
    }
    return { file, before, after };
  }).filter(({ before, after }) => before !== after);

  if (prepare === 'true') {
    for (const { file, after } of edits) writeFileSync(file, after);
  } else if (edits.length) {
    throw new Error('version mismatch in ' + edits.map(({ file }) => file).join(', ') +
      '; run ./scripts/release.sh --prepare v' + version + ', then commit and push the changes');
  }
} catch (error) {
  console.error('release: ' + error.message);
  process.exitCode = 1;
}
NODE
}

if [[ $prepare == true ]]; then
  sync_versions
  printf 'Prepared %s (Windows %s). Review, commit, and push before publishing.\n' "$tag" "$windows_version"
  exit 0
fi

command -v git >/dev/null || fail 'git is required to publish'
command -v gh >/dev/null || fail 'GitHub CLI (gh) is required to publish'

if [[ -n ${GH_TOKEN:-} && ( $GH_TOKEN == "${GITHUB_TOKEN:-}" || $GH_TOKEN == ghs_* ) ]]; then
  fail 'GH_TOKEN must not be an Actions automatic or installation token; use a PAT or gh auth login'
fi
if [[ -n ${GITHUB_TOKEN:-} ]]; then
  printf 'release: ignoring GITHUB_TOKEN; authenticate via gh auth login or a PAT in GH_TOKEN.\n' >&2
fi
unset GITHUB_TOKEN
export GH_PROMPT_DISABLED=1

git_repo() { git -C "$root" "$@"; }

branch=$(git_repo symbolic-ref --quiet HEAD) || fail 'check out a branch before publishing (detached HEAD)'
commit=$(git_repo rev-parse --verify HEAD) || fail 'could not resolve HEAD to a commit'
status=$(git_repo status --porcelain=v1 --untracked-files=all --ignore-submodules=none) || fail 'could not check worktree status'
[[ -z $status ]] || fail 'worktree is not clean; commit or remove changes before publishing'
sync_versions "$commit"

# Resolve the repository from origin, not gh defaults or GH_REPO. The branch
# and tag are verified against the same GitHub repository we publish to.
origin=$(git_repo config --get-all remote.origin.url) || fail 'no origin remote URL configured'
remote_pattern='^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/?$'
[[ $origin =~ $remote_pattern ]] || fail 'origin must be a single github.com HTTPS or SSH remote'
repo=${BASH_REMATCH[2]}
repo=${repo%.git}
[[ $repo != */ && $repo != */. && $repo != */.. ]] || fail 'invalid GitHub repository in origin URL'
endpoint=repos/$repo
api() { gh api --hostname github.com "$@"; }

branch_name=${branch#refs/heads/}
encoded_branch=$(node -p 'encodeURIComponent(process.argv[1])' -- "$branch_name")
remote_commit=$(api "$endpoint/git/ref/heads/$encoded_branch" --jq '.object.sha') ||
  fail "cannot verify origin/$branch_name; push the branch and check GitHub authentication"
[[ $remote_commit == "$commit" ]] || fail "HEAD is not the current tip of origin/$branch_name; sync the branch before publishing"

# Match the exact tag (the endpoint does prefix matching). Peel annotated tags
# before comparing so that a tag's own object ID is not mistaken for its commit.
ref=refs/tags/$tag
remote_tag=$(api "$endpoint/git/matching-refs/tags/$tag" --jq ".[] | select(.ref == \"$ref\") | [.object.type, .object.sha] | @tsv") ||
  fail "could not verify remote tag $tag"
if [[ -n $remote_tag ]]; then
  IFS=$'\t' read -r object_type object_sha <<< "$remote_tag"
  depth=0
  while [[ $object_type == tag ]]; do
    [[ $object_sha =~ ^[0-9a-f]{40}$ && $depth -lt 32 ]] || fail "cannot resolve annotated remote tag $tag"
    object=$(api "$endpoint/git/tags/$object_sha" --jq '[.object.type, .object.sha] | @tsv') ||
      fail "could not read annotated remote tag $tag"
    IFS=$'\t' read -r object_type object_sha <<< "$object"
    depth=$((depth + 1))
  done
  [[ $object_type == commit && $object_sha == "$commit" ]] || fail "remote tag $tag does not point to HEAD; refusing to publish"
else
  # Creating a ref is atomic and rejects a name that already exists. Do not
  # let the release endpoint implicitly create/reuse a tag on a different SHA.
  api "$endpoint/git/refs" --method POST --raw-field "ref=$ref" --raw-field "sha=$commit" --silent ||
    fail "could not create remote tag $tag; no release was published"
fi

args=(--repo "github.com/$repo" --verify-tag "$notes")
if [[ -n $suffix ]]; then
  args+=(--prerelease --latest=false)
fi
if ! gh release create "$tag" "${args[@]}"; then
  fail "could not publish $tag; check GitHub for an existing release before retrying (the remote tag was not removed)"
fi
