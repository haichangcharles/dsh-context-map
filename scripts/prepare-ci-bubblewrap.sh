#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

# Use signed current distribution indices, not a version-specific archive URL.
# Private indices avoid shared apt locks and never install packages system-wide.
root="$(mktemp -d "${RUNNER_TEMP}/dsh-bubblewrap.XXXXXX")"
lists="$root/apt-lists"
archives="$root/archives"
configuration="$root/apt-options.conf"
mkdir -p "$lists/partial" "$archives"
trap 'rm -rf "$lists" "$archives" "$configuration"' EXIT
# Distribution update hooks can write global caches even with private indices.
printf '%s\n' '#clear APT::Update::Post-Invoke;' '#clear APT::Update::Post-Invoke-Success;' > "$configuration"
apt_options=(-c "$configuration" -o "Dir::State::lists=$lists" -o 'Dir::Cache::pkgcache=' -o 'Dir::Cache::srcpkgcache='
  -o 'Acquire::AllowInsecureRepositories=false' -o 'APT::Get::AllowUnauthenticated=false')
apt-get "${apt_options[@]}" update -q
(cd "$archives" && apt-get "${apt_options[@]}" download bubblewrap)
packages=("$archives"/bubblewrap_*_amd64.deb)
if [[ "${#packages[@]}" != 1 || ! -f "${packages[0]}" ]]; then
  echo 'expected exactly one authenticated amd64 bubblewrap package' >&2
  exit 1
fi
dpkg-deb --extract "${packages[0]}" "$root"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"
echo 'bubblewrap functional probe passed'
