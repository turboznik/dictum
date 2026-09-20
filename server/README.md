# Dictum server

The Dictum server is a [Deno](https://deno.com/) service hosting the two things the Dictum
desktop app is not allowed to reach on its own:

| Service                     | Base path                  | Talks to                       |
| --------------------------- | -------------------------- | ------------------------------ |
| **Model mirror**            | `/dictum/api/hf`           | nothing — serves offline files |
| **Post-processing gateway** | `/dictum/api/post-process` | OpenRouter, per request        |

The desktop app never contacts Hugging Face, and never contacts OpenRouter directly.

> **This is a starter kit, not a production service.** It binds loopback, its gateway
> credential is a public constant, and its model mirror is unauthenticated. Adopters are
> expected to replace the authentication and deployment story before putting it on a
> network. See [Adapting this for real use](#adapting-this-for-real-use).

## Quick start

```bash
cd server

# 1. Put the OpenRouter credential in place (not committed).
echo 'OPENROUTER_API_KEY=sk-or-...' > .env

# 2. Populate the model mirror and derive the desktop app's model catalog.
deno task hf

# 3. Run the server.
deno task start
```

Then build the desktop app as usual. It picks up the endpoint at compile time.

Check the server is up:

```bash
curl http://localhost:8000/dictum/health
```

## Configuration

One file is the source of truth for both sides: **`dictum.config.json` at the repository
root**.

```json
{
  "serverBaseUrl": "http://localhost:8000/dictum",
  "postProcessModel": "openai/gpt-5.6-luna"
}
```

The desktop app compiles this in (`src-tauri/src/dictum_config.rs`) and the server reads
the same file at runtime (`server/config.ts`), so a build and the server it talks to
cannot drift apart. Changing `serverBaseUrl` **requires rebuilding the desktop app** — the
endpoint is part of a corporate build's identity, not a user setting.

The only other configuration is `server/.env`:

| Variable             | Purpose                                    |
| -------------------- | ------------------------------------------ |
| `OPENROUTER_API_KEY` | The gateway's own credential to OpenRouter |

## The model mirror

Dictum ships a **Dictum model catalog** compiled into the binary, and downloads the model
files themselves from the mirror. Both come from one deliberate step.

### How a model gets into a build

1. Edit `server/scripts/hf/config.json` — an array of model IDs:

   ```json
   ["handy-computer/parakeet-unified-en-0.6b-gguf"]
   ```

   Valid IDs are the `id` values in `src-tauri/src/catalog/catalog.original.json`, the
   pinned **upstream model catalog**.

2. Run the task:

   ```bash
   deno task hf
   ```

   It validates every ID against the snapshot and **fails before writing anything** if one
   is unknown, duplicated, unpinned, or has no checksum. Then it:

   - replaces `src-tauri/src/catalog/catalog.json` — the committed Dictum model catalog —
     with just the selected models, and
   - downloads each model's **default quantization only** into `scripts/hf/data/blobs/`,
     verifying the sha256 as it streams.

3. Rebuild the desktop app, and restart the server so it re-reads the manifest.

Pass `--catalog-only` to regenerate the catalog without downloading anything.

Re-runs are cheap: an already-present, correctly-sized blob is skipped, and blobs no
longer selected are left on disk rather than deleted.

### Why it works this way

See
[`docs/adr/0003`](../docs/adr/0003-derive-a-committed-model-catalog-from-a-pinned-snapshot.md).
In short: keeping the generated catalog in Git preserves ordinary offline desktop builds,
and keeping the upstream refresh separate (`scripts/gen_catalog.py`) makes model and
metadata changes reviewable instead of incidental.

### Storage layout

```
server/scripts/hf/data/
├── manifest.json          # repo/revision/filename -> {sha256, size}
└── blobs/
    └── <sha256>           # the file, named by its own content hash
```

Requests are resolved through the manifest, never by joining request path segments onto a
filesystem path. The only name that ever reaches the disk is a manifest-supplied sha256
matched against `/^[0-9a-f]{64}$/`, so there is nothing for a traversal attempt to
traverse.

The `data/` directory is tracked but its contents are not — model files do not belong in
Git.

### The wire contract

The mirror implements the slice of the Hugging Face API that `hf-hub` uses, so the desktop
app's only change is its endpoint:

```
GET {endpoint}/{repo_id}/resolve/{revision}/{filename}
```

- A `Range: bytes=0-0` probe returns `206` with `etag` (the content hash),
  `x-repo-commit`, and `x-linked-size`.
- Ranged requests return exactly the requested window.
- Bodies are streamed; a 1.2 GB model never sits in server memory.
- No redirects, and no route but the one above.

## The post-processing gateway

An OpenAI-compatible endpoint the desktop app reaches through its inherited "Custom"
provider — no new client code.

```
POST /dictum/api/post-process/chat/completions
Authorization: Bearer SAFE_FOR_TESTING
```

Because that credential is public, the gateway is written as though already exposed. It
accepts a fixed envelope:

- **Kept:** `messages`, and `response_format` (Dictum's structured-output schema).
- **Forced:** `model` (always `postProcessModel`) and `stream: false`.
- **Dropped:** sampling, `tools`, `plugins`, provider routing, and everything else a
  client might send.
- **Bounded:** 256 KB request, 16 messages, 60-second upstream timeout.
- **Quiet:** transcripts and responses are never logged, and errors are generic so
  OpenRouter's account and model details do not leak to a client.

`/models` is deliberately absent: the model is fixed and the desktop app's model picker is
hidden.

## Development

```bash
deno task test    # 26 tests, no network required
deno check *.ts
deno fmt
```

The tests cover the byte-range contract, route allowlisting, the request envelope, and the
auth gate. None of them reach OpenRouter or Hugging Face.

## Adapting this for real use

This repository deliberately stops short of production. An adopter should expect to change
at least:

1. **Gateway authentication.** `GATEWAY_API_KEY` in `post-process.ts` is the constant
   `SAFE_FOR_TESTING`. Replace this check with real per-user credentials.
2. **Model mirror authentication.** The mirror is unauthenticated and relies on the
   loopback binding. A central deployment needs gateway or network-level access control.
3. **The bind address.** `main.ts` binds `127.0.0.1` on purpose.
4. **Desktop credential storage.** The desktop app stores the gateway key in its ordinary
   settings file, which only guards against accidental debug printing.
5. **`serverBaseUrl`.** Point it at the real deployment and rebuild the app.
