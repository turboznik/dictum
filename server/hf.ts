/**
 * The Dictum model mirror.
 *
 * Serves the subset of the upstream model catalog an adopter selected, in the
 * shape `hf-hub` expects, so the desktop app reaches it by changing only its
 * API endpoint. It never contacts Hugging Face: everything it serves was
 * placed in `scripts/hf/data` beforehand by the `hf` task.
 *
 * Two properties make this safe to expose:
 *
 *  - Requests are resolved through a manifest, never by joining request path
 *    segments onto a filesystem path. The only name that ever reaches the disk
 *    is a manifest-supplied sha256 validated against /^[0-9a-f]{64}$/, so path
 *    traversal has nothing to traverse.
 *  - Bodies are streamed. A 1.2 GB model never sits in server memory.
 */

import { MODEL_MIRROR_PREFIX } from "./config.ts";

const DATA_DIR = new URL("./scripts/hf/data/", import.meta.url);
const MANIFEST_URL = new URL("manifest.json", DATA_DIR);

export interface ManifestEntry {
  sha256: string;
  size: number;
}

export interface Manifest {
  generated_at: string;
  entries: Record<string, ManifestEntry>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * `{repo_id}/resolve/{revision}/{filename}`, where repo_id is `org/name`.
 * Anchored and segment-exact: nothing else is a route.
 */
const RESOLVE_RE =
  /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/resolve\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

let manifest: Manifest | null = null;

export async function loadManifest(): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(MANIFEST_URL)) as Manifest;
    if (!parsed.entries || typeof parsed.entries !== "object") {
      throw new Error("manifest has no entries map");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // An empty mirror is a valid state: the adopter has not run `deno task hf`
      // yet. Serving 404s beats refusing to start, because the post-processing
      // gateway on the same server is unaffected.
      return { generated_at: "never", entries: {} };
    }
    throw error;
  }
}

export async function manifestOnce(): Promise<Manifest> {
  manifest ??= await loadManifest();
  return manifest;
}

/** Drops the cached manifest so a re-run of `deno task hf` is picked up. */
export function invalidateManifest(): void {
  manifest = null;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses the single-range `bytes=start-end` forms hf-hub sends. Returns null
 * for an absent header and "invalid" for anything unsatisfiable, which the
 * caller answers with 416 rather than silently sending the whole file.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | null | "invalid" {
  if (header === null) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;

  if (rawStart === "" && rawEnd === "") return "invalid";

  // Suffix form `bytes=-N`: the last N bytes.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "invalid";

  // Open-ended form `bytes=N-`: through the end of the file.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "invalid";

  return { start, end };
}

function notFound(): Response {
  // Deliberately opaque: a probe cannot tell an unmirrored model from a
  // malformed path, and the body never echoes request input.
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * Handles a model mirror request, or returns null when the path is not a
 * mirror route so the caller can fall through to its own 404.
 */
export async function handleModelMirror(
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith(`${MODEL_MIRROR_PREFIX}/`)) return null;

  const relative = url.pathname.slice(MODEL_MIRROR_PREFIX.length);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { "content-type": "text/plain", allow: "GET, HEAD" },
    });
  }

  const match = RESOLVE_RE.exec(relative);
  if (!match) return notFound();

  const [, org, name, revision, filename] = match;
  const key = `${org}/${name}/${revision}/${filename}`;

  const entry = (await manifestOnce()).entries[key];
  if (!entry) return notFound();

  // The manifest is generated, but treat it as untrusted anyway: this value is
  // about to become a filesystem name.
  if (!SHA256_RE.test(entry.sha256)) return notFound();

  const blobPath = new URL(`blobs/${entry.sha256}`, DATA_DIR);

  let file: Deno.FsFile;
  try {
    file = await Deno.open(blobPath, { read: true });
  } catch {
    // Manifest lists it, disk does not have it — a half-finished `hf` run.
    return notFound();
  }

  const size = entry.size;

  // hf-hub reads the file's identity from these three headers. The etag is the
  // content hash, which is what makes the shared cache's blob naming stable
  // across a re-run of the `hf` task.
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    etag: `"${entry.sha256}"`,
    "x-repo-commit": revision,
    "x-linked-size": String(size),
    "x-linked-etag": `"${entry.sha256}"`,
    // Content is immutable: a revision is a commit sha and the etag is the
    // content hash, so nothing at this URL can ever change.
    "cache-control": "public, max-age=31536000, immutable",
  });

  const range = parseRange(request.headers.get("range"), size);

  if (range === "invalid") {
    file.close();
    return new Response("Range not satisfiable\n", {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "content-type": "text/plain" },
    });
  }

  if (request.method === "HEAD") {
    file.close();
    headers.set("content-length", String(size));
    return new Response(null, { status: 200, headers });
  }

  if (range === null) {
    headers.set("content-length", String(size));
    return new Response(file.readable, { status: 200, headers });
  }

  const length = range.end - range.start + 1;
  await file.seek(range.start, Deno.SeekMode.Start);

  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);

  // Stream exactly the requested window, then stop: `readable` would otherwise
  // run to the end of the file.
  const body = limitedStream(file, length);

  return new Response(body, { status: 206, headers });
}

/**
 * Streams at most `length` bytes from an open file, closing it when done.
 * Chunked so a ranged read of a large model never buffers the whole window.
 */
function limitedStream(file: Deno.FsFile, length: number): ReadableStream<Uint8Array> {
  const CHUNK = 64 * 1024;
  let remaining = length;

  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        file.close();
        return;
      }

      const buffer = new Uint8Array(Math.min(CHUNK, remaining));
      const read = await file.read(buffer);

      if (read === null) {
        // Truncated blob; end the body rather than hang the client.
        controller.close();
        file.close();
        return;
      }

      remaining -= read;
      controller.enqueue(buffer.subarray(0, read));
    },
    cancel() {
      file.close();
    },
  });
}
