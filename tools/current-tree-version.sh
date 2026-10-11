#!/bin/sh
# The suite's version, v<yyyy>.<mm>.<dd>-<6 hex>: the date (UTC) and the first 6 hex digits of a commit
# (default HEAD), e.g. v2026.10.11-02d794. Versions are compared by date alone (VO.compareVersions).
#   tools/current-tree-version.sh [commit]
# desktop/build.sh stamps it into the desktop app; the published site's VO.VERSION should follow it.
# It is never written anywhere by itself: public/updater/current.json is edited by hand.
set -eu
commit=${1:-HEAD}
day=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y.%m.%d "$commit")
hash=$(git rev-parse "$commit" | cut -c1-6)
echo "v$day-$hash"
