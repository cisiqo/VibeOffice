#!/bin/sh
# Makes a copy of public/ the published site of one version (tools/current-tree-version.sh):
#
#   tools/web-release.sh <copy of public/> <version>
#
# - stamps the version into common/suite.js (VO.VERSION = 'dev';) and sw.js (const VERSION = 'dev';);
# - packs updater/web-<version>.zip, the whole site the service worker downloads and caches (public/sw.js): every
#   file but sw.js, updater/ and hidden files, deflated, without folder entries or extra attributes.
# Needs zip (Info-ZIP). ../cf-vibeoffice/sync-cf-pages.sh runs it on the copy it deploys; never run it on public/
# itself.
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <copy of public/> <version>" >&2; exit 2; }
DIR=$1
VERSION=$2
case $VERSION in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "Not a version (v<yyyy>.<mm>.<dd>-<6 hex>): $VERSION" >&2; exit 1 ;;
esac
[ -f "$DIR/common/suite.js" ] && [ -f "$DIR/sw.js" ] || { echo "Not a copy of public/: $DIR" >&2; exit 1; }
[ "$(cd "$DIR" && pwd -P)" != "$(cd "$(dirname "$0")/../public" && pwd -P)" ] || { echo "Refusing to stamp public/ itself" >&2; exit 1; }
command -v zip > /dev/null || { echo "Needs zip (Info-ZIP)" >&2; exit 1; }

# replace the one line that says 'dev'
stamp() {
  [ "$(grep -cF "$2" "$1")" = 1 ] || { echo "Not exactly one line $2 in $1" >&2; exit 1; }
  sed -i.bak "s/$2/$3/" "$1" && rm -f "$1.bak"
}
stamp "$DIR/common/suite.js" "VO.VERSION = 'dev';" "VO.VERSION = '$VERSION';"
stamp "$DIR/sw.js" "const VERSION = 'dev';" "const VERSION = '$VERSION';"

LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT
(cd "$DIR" && find . -type f ! -path './updater/*' ! -path ./sw.js ! -path '*/.*' | sed 's|^\./||' | LC_ALL=C sort) > "$LIST"
# the names the service worker accepts (PATH in sw.js): no spaces, quotes or hidden parts
if grep -vqE '^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$' "$LIST"; then
  echo "File names the service worker won't take:" >&2
  grep -vE '^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$' "$LIST" >&2
  exit 1
fi

mkdir -p "$DIR/updater"
rm -f "$DIR"/updater/web-*.zip
OUT="$(cd "$DIR" && pwd -P)/updater/web-$VERSION.zip"
(cd "$DIR" && zip -q -X -D -9 "$OUT" -@ < "$LIST")
echo "$DIR: $VERSION, $(wc -l < "$LIST" | tr -d ' ') files in updater/web-$VERSION.zip ($(wc -c < "$OUT" | tr -d ' ') bytes)"
