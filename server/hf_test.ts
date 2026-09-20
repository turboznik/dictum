/**
 * Model mirror tests.
 *
 * The wire contract here is not ours — it is whatever `hf-hub` sends and
 * expects, because the desktop app's only change is its API endpoint. These
 * tests pin the parts of that contract a refactor could silently break: the
 * `bytes=0-0` metadata probe's headers, exact-window range replies, and the
 * route shape. Getting any of them wrong breaks model downloads in a way that
 * only shows up in a built app.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { parseRange } from "./hf.ts";

Deno.test("parseRange: absent header means the whole file", () => {
  assertEquals(parseRange(null, 100), null);
});

Deno.test("parseRange: hf-hub's metadata probe asks for one byte", () => {
  assertEquals(parseRange("bytes=0-0", 100), { start: 0, end: 0 });
});

Deno.test("parseRange: a closed window is inclusive on both ends", () => {
  assertEquals(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
});

Deno.test("parseRange: an open-ended window runs to the last byte", () => {
  assertEquals(parseRange("bytes=90-", 100), { start: 90, end: 99 });
});

Deno.test("parseRange: an over-long window is clamped, not rejected", () => {
  // hf-hub computes its final chunk's stop from the file length it was told,
  // so an off-by-one there must not fail the download.
  assertEquals(parseRange("bytes=95-999", 100), { start: 95, end: 99 });
});

Deno.test("parseRange: a suffix window counts back from the end", () => {
  assertEquals(parseRange("bytes=-10", 100), { start: 90, end: 99 });
});

Deno.test("parseRange: a start at or past EOF is unsatisfiable", () => {
  assertEquals(parseRange("bytes=100-200", 100), "invalid");
});

Deno.test("parseRange: malformed headers are rejected rather than ignored", () => {
  // Answering a malformed range with the whole file would hand hf-hub bytes it
  // would then write at the wrong offset.
  for (const header of ["bytes=", "bytes=-", "items=0-1", "bytes=a-b", "0-1", ""]) {
    assertEquals(parseRange(header, 100), "invalid", `expected invalid for "${header}"`);
  }
});

Deno.test("parseRange: a reversed window is unsatisfiable", () => {
  assertEquals(parseRange("bytes=50-10", 100), "invalid");
});

// --- Route and header contract, exercised against the real handler ---

const BASE = "http://localhost:8000/dictum/api/hf";

/** The four path segments of a resolve URL, as hf-hub builds it. */
const REPO = "handy-computer/canary-180m-flash-gguf";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const FILENAME = "canary-180m-flash-Q8_0.gguf";

/**
 * Goes through the server's own handler rather than the mirror module, so a
 * path is judged by what a client actually receives. A path that normalizes
 * out of the mirror's namespace never reaches the mirror at all, and the
 * distinction is irrelevant to a caller — both are 404.
 */
async function get(path: string, headers?: HeadersInit): Promise<Response> {
  const { handler } = await import("./main.ts");
  return await handler(new Request(new URL(`${BASE}${path}`), { headers }));
}

Deno.test("a path that is not a resolve route is not served", async () => {
  // Anything but the one allowlisted shape, including attempts to walk out of
  // the mirror's namespace or address its own manifest.
  for (
    const path of [
      "/",
      `/${REPO}`,
      `/${REPO}/blob/${REVISION}/${FILENAME}`,
      `/${REPO}/resolve/${REVISION}`,
      `/${REPO}/resolve/${REVISION}/${FILENAME}/extra`,
      "/../../../etc/passwd",
      `/${REPO}/resolve/${REVISION}/..%2f..%2fmanifest.json`,
      "/manifest.json",
      "/blobs/x",
    ]
  ) {
    const response = await get(path);
    assertEquals(response.status, 404, `expected 404 for ${path}`);
    await response.body?.cancel();
  }
});

Deno.test("a well-formed route for an unmirrored model is 404, not an error", async () => {
  const response = await get(`/${REPO}/resolve/${REVISION}/${FILENAME}`);
  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test("writes are refused", async () => {
  const { handleModelMirror } = await import("./hf.ts");
  const url = new URL(`${BASE}/${REPO}/resolve/${REVISION}/${FILENAME}`);
  const response = await handleModelMirror(new Request(url, { method: "DELETE" }), url);
  assertEquals(response?.status, 405);
  await response?.body?.cancel();
});

Deno.test("paths outside the mirror prefix are left to the caller", async () => {
  const { handleModelMirror } = await import("./hf.ts");
  const url = new URL("http://localhost:8000/dictum/api/post-process/chat/completions");
  assertEquals(await handleModelMirror(new Request(url), url), null);
});
