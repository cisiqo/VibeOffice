# WOPI

VibeOffice can run as a WOPI client for a WOPI host such as a document-management system. This is an
optional deployment mode: the normal site remains static and continues to open local files entirely in
the browser. WOPI mode uses `tools/wopi/server.py`, a small standard-library Python gateway, because a
WOPI launch sends its access token in an HTTP POST and file operations are server-to-server requests.

## What is implemented

- Discovery at `/hosting/discovery` for the OOXML formats Quire, Ledger and Lectern edit.
- Capabilities at `/hosting/capabilities`.
- Standard launch POST with `WOPISrc`, `access_token` and `access_token_ttl`.
- CheckFileInfo and GetFile.
- Lock, RefreshLock, GetLock, Unlock and UnlockAndRelock, including one bounded recovery attempt after
  a refresh failure or a page returning from the background.
- PutFile for Save and PutRelativeFile for Save As.
- RenameFile from the File menu in WOPI edit sessions (including the Paper 2016 File menu).
- DeleteFile from the File menu, with host permission and lock checks.
- Pre-save Version checks, structured lock/version conflicts and SHA-256 reconciliation when a PutFile
  response is lost. An uncertain or stale save is never replayed blindly; the user can keep edits with a
  PutRelativeFile conflict copy instead.
- Save-level coauthor coordination. Gateway sessions for the same WOPISrc share one host lock and
  receive save, rename and delete events. A clean peer reloads the new version; a dirty peer keeps its
  local work and uses the existing conflict-copy path instead of silently overwriting.
- CheckEcosystem, GetRootContainer, CheckContainerInfo, EnumerateChildren, CreateChildFile,
  EnumerateAncestors and GetFileEcosystem against the local host's single root container.
- A trusted-origin postMessage bridge for `Host_PostmessageReady`, focus, history, performance and frame
  trust messages, plus host requests for edit, embed, versions, sharing and workflow UI. Messages are
  never sent to `*`.
- Read-only CheckFileInfo responses: the file opens in a viewer layout without editing bars, and attempts
  to save are refused.
- Optional RSA SHA-256 WOPI proof-key signing, including discovery metadata and current/old key rotation.
- Optional OAuth bootstrap token refresh before expiry. A failed write is never replayed after a 401.

WOPI sessions and access tokens are kept only in gateway memory. `access_token_ttl=0` explicitly means
that the token does not expire; the random browser session still expires after 12 hours. The browser receives a random session
identifier, never the access token or a token-bearing WOPI URL. Restarting the gateway ends its sessions;
the host can launch the editor again. With an OAuth token, the gateway proactively asks the WOPI
bootstrapper for a replacement finite token within five minutes of expiry. Without one, or if refresh
fails, a 401 requires a new launch.

Coauthoring is document/save-level coordination, not a CRDT or character-level merge. Users do not see
each other's cursor or unsaved keystrokes. Simultaneous dirty edits deliberately produce a version
conflict and offer a separate conflict copy.

## Run

Production WOPI clients need a public HTTPS origin. Put the gateway behind the site's TLS reverse proxy:

```sh
python3 tools/wopi/server.py \
  --bind 127.0.0.1 --port 8761 \
  --public-url https://office.example.com \
  --wopi-host https://cloud.example.com \
  --proof-key /run/secrets/wopi-proof-private.pem \
  --proof-key-old /run/secrets/wopi-proof-previous.pem \
  --oauth-token "$WOPI_OAUTH_TOKEN"
```

`--wopi-host` is required and may be repeated. It is an exact allowed origin, including a non-default
port. This allowlist prevents the gateway from becoming an arbitrary server-side request proxy.
WOPISrc paths may use the standard `/wopi/files/{id}` form or a compatible prefix such as
`/WopiHost/files/{id}`.

Point the WOPI host's office/WOPI-client setting at:

```text
https://office.example.com
```

The host fetches `https://office.example.com/hosting/discovery`, chooses an action for the file's MIME
type, and posts the launch form to the corresponding Quire, Ledger or Lectern URL. The reverse proxy must:

- pass GET and POST request bodies unchanged;
- allow uploads as large as the largest document (the gateway limit is 512 MiB);
- use a timeout longer than 60 seconds for large saves;
- not add `X-Frame-Options: DENY` or a conflicting `frame-ancestors` policy.

The gateway sets the launch page's `frame-ancestors` from CheckFileInfo's `PostMessageOrigin`, falling
back to the WOPI host origin. All browser-side session writes additionally require the editor's own
Origin header.

`--proof-key` signs each host request with `X-WOPI-TimeStamp`, `X-WOPI-Proof` and
`X-WOPI-ProofOld`, and publishes the matching public key in discovery. During rotation,
`--proof-key-old` is the previous private key; otherwise ProofOld uses the current key. Keep private
keys outside the web root and repository. The host must validate the proof timestamp and one of the
current/old key combinations.

`--oauth-token` is a server-side bearer credential for the host's WOPI bootstrapper. It is never sent to
the browser. Token refresh is proactive only; the gateway does not retry a write whose result might
already have reached the host.

For local protocol testing, HTTP and loopback hosts work:

```sh
python3 tools/wopi/server.py \
  --public-url http://127.0.0.1:8761 \
  --wopi-host http://127.0.0.1:8080 \
  --proof-key /Users/cisiqo/docker/php7-wopi/keys/proof-private.pem \
  --oauth-token dev-oauth
```

This starts the WOPI gateway at `127.0.0.1:8761`; it is separate from `tools/serve.py`.
The Compose reference host enables proof validation, so omitting `--proof-key` makes it reject the
launch with `Missing or invalid WOPI proof timestamp`. Use the same private key whose public half is
mounted into the PHP container.

### Local PHP reference host

The development host in `/Users/cisiqo/docker/php7-wopi` reads `WOPI_ACCESS_TOKEN` from its environment
(`dev` is the Compose-only default), validates it with a constant-time comparison on every request, and
returns token-bearing URLs only to the server-side gateway. It writes new content to a temporary file in
the same directory and atomically renames it into place. PutFile requires the current lock; PutFile,
PutRelativeFile and RenameFile return `X-WOPI-ItemVersion`. `WOPI_OAUTH_TOKEN` protects the
bootstrapper and `WOPI_PROOF_PUBLIC_KEY` enables strict proof validation. The reference ecosystem has
one non-renamable root container named Office; it supports listing and creating child files but no
subcontainers.

```sh
cd /Users/cisiqo/docker/php7-wopi
WOPI_ACCESS_TOKEN='replace-this' WOPI_OAUTH_TOKEN='replace-oauth' \
  docker compose up -d --force-recreate
WOPI_ACCESS_TOKEN='replace-this' WOPI_OAUTH_TOKEN='replace-oauth' python3 test_wopi.py
```

`tools/wopi/preview.html` is a manual launch page for opening sample DOCX, XLSX and PPTX files from a
local WOPI host. Serve that directory over loopback (or open the desktop copy), then set the gateway,
host and token fields. Its local static-token launch sends `access_token_ttl=0`.

## Tests

```sh
python3 -m unittest tools/wopi/test_server.py
```

The test starts a fake WOPI host and the real gateway, then exercises discovery, launch, CheckFileInfo,
GetFile, locks and shared-lock recovery, PutFile, PutRelativeFile, RenameFile, DeleteFile, save events,
token refresh, proof signatures, stale-version refusal and lost-response reconciliation. The PHP host
test additionally covers proof validation, ecosystem/container routes and bootstrap refresh. Before
deploying, also test open, edit, Save, Save As, Rename, Delete, two concurrent sessions and read-only
access against the actual host, because hosts differ in their optional CheckFileInfo properties.

## Source

| File | Purpose |
|---|---|
| `public/common/wopi.js` | Browser-side session, opening, saving, locks and postMessage |
| `tools/wopi/server.py` | Discovery, launch endpoint, token/session storage and WOPI proxy |
| `tools/wopi/test_server.py` | Gateway integration test with a fake WOPI host |
