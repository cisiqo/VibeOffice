#!/bin/sh
# Has the whole of tests/ui/ run on public/ as it is now? Compares a hash of public/'s content (committed or not) with
# the one tools/ui-full.mjs recorded in .ui-full-tested.json (ignored by Git, like every hidden file). Prints what it
# found; exits 1, with a warning on stderr, when the suite has not run on this content or had failures.
# tools/web-release.sh and ../cf-vibeoffice/sync-cf-pages.sh warn with it before a release (docs/testing.md).
#
#   tools/ui-tested.sh           check
#   tools/ui-tested.sh --hash    print the hash of public/'s content
set -eu
cd "$(dirname "$0")/.."

# the tree public/ would be if committed now: its files added to an index of their own
idx=$(mktemp); rm -f "$idx"
GIT_INDEX_FILE=$idx git add -A -- public
HASH=$(GIT_INDEX_FILE=$idx git write-tree --prefix=public/)
rm -f "$idx"
[ "${1:-}" = --hash ] && { echo "$HASH"; exit 0; }

[ -f .ui-full-tested.json ] || { echo "Warning: the whole UI suite (tests/ui/) has not been run here: node tools/ui-full.mjs (about 25 minutes)" >&2; exit 1; }
HASH=$HASH node -e '
  const r = JSON.parse(require("fs").readFileSync(".ui-full-tested.json", "utf8")), at = `${r.commit.slice(0, 7)}${r.dirty ? " with uncommitted changes" : ""}, ${r.date.slice(0, 16).replace("T", " ")} UTC`;
  if (r.public !== process.env.HASH) { console.error(`Warning: the whole UI suite last ran on ${at}, and public/ has changed since: node tools/ui-full.mjs (about 25 minutes)`); process.exit(1); }
  if (r.fail) { console.error(`Warning: the whole UI suite ran on this public/ (${at}) with ${r.fail} failing:\n${r.failures.map((f) => "  " + f).join("\n")}`); process.exit(1); }
  console.log(`The whole UI suite passed on this public/ (${at}): ${r.pass} tests${r.todo ? `, ${r.todo} todo` : ""}.`);'
