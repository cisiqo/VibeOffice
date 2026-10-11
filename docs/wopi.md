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
- Lock, RefreshLock and Unlock.
- PutFile for Save and PutRelativeFile for Save As.
- `App_LoadingStatus`, `Edit_Notification`, `File_Rename` and `UI_Close` postMessages.
- Read-only CheckFileInfo responses: the file opens in a viewer layout without editing bars, and attempts
  to save are refused.

WOPI sessions and access tokens are kept only in gateway memory. The browser receives a random session
identifier, never the access token or a token-bearing WOPI URL. Restarting the gateway ends its sessions;
the host can launch the editor again.

This is single-user editing, not WOPI coauthoring. Locks prevent another editor from overwriting the same
file, but changes from multiple users are not merged.

## Run

Production WOPI clients need a public HTTPS origin. Put the gateway behind the site's TLS reverse proxy:

```sh
python3 tools/wopi/server.py \
  --bind 127.0.0.1 --port 8761 \
  --public-url https://office.example.com \
  --wopi-host https://cloud.example.com
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

For local protocol testing, HTTP and loopback hosts work:

```sh
python3 tools/wopi/server.py \
  --public-url http://127.0.0.1:8761 \
  --wopi-host http://127.0.0.1:9981
```

This starts the WOPI gateway at `127.0.0.1:8761`; it is separate from `tools/serve.py`.
`tools/wopi/preview.html` is a manual launch page for opening sample DOCX, XLSX and PPTX files from a
local WOPI host. Open it directly in a browser and set the gateway, host and token fields.

## Tests

```sh
python3 -m unittest tools/wopi/test_server.py
```

The test starts a fake WOPI host and the real gateway, then exercises discovery, launch, CheckFileInfo,
GetFile, Lock and PutFile. Before deploying, also test open, edit, Save, Save As and read-only access
against the actual host, because hosts differ in their optional CheckFileInfo properties.

## Source

| File | Purpose |
|---|---|
| `public/common/wopi.js` | Browser-side session, opening, saving, locks and postMessage |
| `tools/wopi/server.py` | Discovery, launch endpoint, token/session storage and WOPI proxy |
| `tools/wopi/test_server.py` | Gateway integration test with a fake WOPI host |
