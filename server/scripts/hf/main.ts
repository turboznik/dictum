/**
 * The `hf` task: derive the Dictum model catalog and populate the model mirror.
 *
 * Run by an adopter, deliberately, after editing `config.json`:
 *
 *   cd server && deno task hf
 *
 * It does exactly two things, per docs/adr/0003:
 *
 *  1. Replaces `src-tauri/src/catalog/catalog.json` — the Dictum model catalog
 *     compiled into the desktop app — with the entries `config.json` selected
 *     from the pinned upstream snapshot.
 *  2. Downloads each selected model's default quantization into `data/blobs`
 *     and writes the manifest the model mirror serves from.
 *
 * It never refreshes the upstream snapshot: that is `scripts/gen_catalog.py`,
 * run separately so its large diff gets reviewed on its own.
 *
 * Both steps are re-runnable. Existing, verified blobs are not re-downloaded,
 * and blobs that are no longer selected are left alone rather than deleted — an
 * adopter who trims `config.json` does not lose the bytes.
 */

import { fromFileUrl } from "@std/path";
import { createHash } from "node:crypto";

const HERE = new URL("./", import.meta.url);
const DATA_DIR = new URL("./data/", HERE);
const BLOBS_DIR = new URL("./blobs/", DATA_DIR);
const CONFIG_PATH = new URL("./config.json", HERE);
const MANIFEST_PATH = new URL("./manifest.json", DATA_DIR);

const REPO_ROOT = new URL("../../../", HERE);
const SNAPSHOT_PATH = new URL("src-tauri/src/catalog/catalog.original.json", REPO_ROOT);
const CATALOG_PATH = new URL("src-tauri/src/catalog/catalog.json", REPO_ROOT);

const HF_BASE = "https://huggingface.co";

interface QuantFile {
  filename: string;
  quant: string;
  size_bytes: number;
  sha256?: string;
}

interface CatalogModel {
  id: string;
  revision?: string;
  name: string;
  files: QuantFile[];
  default_quant?: string;
  [key: string]: unknown;
}

interface CatalogRoot {
  catalog_version: number;
  generated_at: string;
  mirrors: string[];
  models: CatalogModel[];
}

interface ManifestEntry {
  sha256: string;
  size: number;
}

/** The file a model downloads by default — the only quant the mirror carries. */
export function defaultQuantFile(model: CatalogModel): QuantFile | undefined {
  if (model.default_quant) {
    const match = model.files.find((file) => file.quant === model.default_quant);
    if (match) return match;
  }
  return model.files[0];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

async function readJson<T>(path: URL, what: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      fail(`${what} not found at ${fromFileUrl(path)}`);
    }
    fail(`${what} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

export interface ValidationResult {
  selected: CatalogModel[];
  problems: string[];
}

/**
 * Checks the allowlist against the snapshot before anything is written.
 *
 * A typo in `config.json` must stop the run, not silently produce a catalog
 * with a model missing — that failure would only surface much later, as a model
 * absent from a built app.
 */
export function validateSelection(
  selection: unknown,
  snapshot: CatalogRoot,
): ValidationResult {
  if (!Array.isArray(selection)) {
    return { selected: [], problems: ["config.json must be an array of model IDs"] };
  }
  if (selection.length === 0) {
    return {
      selected: [],
      problems: ["config.json selects no models; the app would ship an empty catalog"],
    };
  }

  const byId = new Map(snapshot.models.map((model) => [model.id, model]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const selected: CatalogModel[] = [];

  for (const id of selection) {
    if (typeof id !== "string") {
      problems.push(`not a string: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`listed more than once: ${id}`);
      continue;
    }
    seen.add(id);

    const model = byId.get(id);
    if (!model) {
      problems.push(`not in the upstream snapshot: ${id}`);
      continue;
    }

    const file = defaultQuantFile(model);
    if (!file) {
      problems.push(`no downloadable file: ${id}`);
      continue;
    }
    if (!file.sha256 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      // Without a hash there is no way to verify the download, and the mirror
      // refuses to serve unverifiable bytes.
      problems.push(`default quant has no sha256: ${id}`);
      continue;
    }
    if (!model.revision) {
      problems.push(`no pinned revision: ${id}`);
      continue;
    }

    selected.push(model);
  }

  return { selected, problems };
}

/**
 * A carriage-return progress meter, but only onto a terminal.
 *
 * Redirected to a file or a CI log there is nothing to overwrite, so every
 * update would be retained as its own line — a few hundred megabytes of model
 * turns into megabytes of log.
 */
const INTERACTIVE = Deno.stdout.isTerminal();

function progress(label: string, done: number, total: number): void {
  if (!INTERACTIVE) return;
  const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
  Deno.stdout.writeSync(
    new TextEncoder().encode(
      `\r  ${label}  ${percent}%  ${mb(done)}/${mb(total)} MB    `,
    ),
  );
}

function clearProgress(): void {
  if (!INTERACTIVE) return;
  Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[K"));
}

/**
 * Fetches one model file into the content-addressed blob store.
 *
 * Downloads to a temporary name and renames only after the hash matches, so an
 * interrupted run can never leave a blob the mirror would serve as valid.
 */
async function acquire(model: CatalogModel, file: QuantFile): Promise<void> {
  const sha256 = file.sha256!;
  const blobPath = new URL(sha256, BLOBS_DIR);

  const existing = await Deno.stat(blobPath).catch(() => null);
  if (existing?.isFile) {
    if (existing.size === file.size_bytes) {
      console.log(`  have  ${model.name} (${file.quant})`);
      return;
    }
    console.log(`  size mismatch, re-fetching ${model.name} (${file.quant})`);
  }

  const url = `${HF_BASE}/${model.id}/resolve/${model.revision}/${file.filename}`;
  const megabytes = (file.size_bytes / 1024 / 1024).toFixed(0);
  console.log(`  get   ${model.name} (${file.quant}, ${megabytes} MB)`);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    fail(`download failed for ${model.id} (${response.status} ${response.statusText})`);
  }

  const tempPath = new URL(`${sha256}.partial`, BLOBS_DIR);
  const temp = await Deno.open(tempPath, { write: true, create: true, truncate: true });

  // Hashed as it streams: a second pass over a multi-gigabyte blob just to
  // verify it would double the run's disk read for no extra safety.
  const hash = createHash("sha256");
  let written = 0;
  try {
    for await (const chunk of response.body) {
      await temp.write(chunk);
      hash.update(chunk);
      written += chunk.length;
      progress(model.name, written, file.size_bytes);
    }
  } finally {
    temp.close();
    clearProgress();
  }

  const actual = hash.digest("hex");
  if (actual !== sha256) {
    await Deno.remove(tempPath).catch(() => {});
    fail(
      `checksum mismatch for ${model.id}\n    expected ${sha256}\n    actual   ${actual}`,
    );
  }

  await Deno.rename(tempPath, blobPath);
  console.log(`  ok    ${model.name} (${file.quant}) verified`);
}

/**
 * Builds the Dictum model catalog.
 *
 * `mirrors` is emptied on purpose: the desktop app reaches the model mirror
 * through its API endpoint, and an inherited fallback URL would be an egress
 * path around it. `generated_at` records when this catalog was derived, while
 * `upstream_generated_at` preserves when the snapshot it came from was taken —
 * losing that would make the catalog's provenance unreadable.
 */
export function buildCatalog(snapshot: CatalogRoot, selected: CatalogModel[]) {
  return {
    catalog_version: snapshot.catalog_version,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    upstream_generated_at: snapshot.generated_at,
    mirrors: [] as string[],
    models: selected,
  };
}

export function buildManifest(selected: CatalogModel[]) {
  const entries: Record<string, ManifestEntry> = {};

  for (const model of selected) {
    const file = defaultQuantFile(model)!;
    entries[`${model.id}/${model.revision}/${file.filename}`] = {
      sha256: file.sha256!,
      size: file.size_bytes,
    };
  }

  return { generated_at: new Date().toISOString(), entries };
}

async function main(): Promise<void> {
  const catalogOnly = Deno.args.includes("--catalog-only");

  const snapshot = await readJson<CatalogRoot>(SNAPSHOT_PATH, "upstream model catalog");
  const selection = await readJson<unknown>(CONFIG_PATH, "config.json");

  const { selected, problems } = validateSelection(selection, snapshot);

  if (problems.length > 0) {
    console.error("config.json does not match the upstream snapshot:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\nValid IDs come from the 'id' field in ${fromFileUrl(SNAPSHOT_PATH)}.`,
    );
    Deno.exit(1);
  }

  console.log(`selected ${selected.length} model(s):`);
  for (const model of selected) console.log(`  - ${model.name}  (${model.id})`);

  const catalog = buildCatalog(snapshot, selected);
  await Deno.writeTextFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(
    `\nwrote ${fromFileUrl(CATALOG_PATH)}: ` +
      `${selected.length} of ${snapshot.models.length} models`,
  );

  if (catalogOnly) {
    console.log("\n--catalog-only: skipping model downloads");
    return;
  }

  await Deno.mkdir(BLOBS_DIR, { recursive: true });

  console.log("\nacquiring model files:");
  for (const model of selected) {
    await acquire(model, defaultQuantFile(model)!);
  }

  const manifest = buildManifest(selected);
  await Deno.writeTextFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fromFileUrl(MANIFEST_PATH)}: ${selected.length} entries`);

  console.log("\ndone. Restart the Dictum server to pick up the new manifest.");
}

if (import.meta.main) {
  await main();
}
