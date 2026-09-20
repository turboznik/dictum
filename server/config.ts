/**
 * The shared Dictum server configuration.
 *
 * Read from the repository-root `dictum.config.json` — the same file the
 * desktop app compiles in — so a build and the server it talks to cannot
 * disagree about where the endpoints live.
 */

export interface DictumConfig {
  /** Base URL of the Dictum server, without a trailing slash. */
  serverBaseUrl: string;
  /** The only model the post-processing gateway will ever ask OpenRouter for. */
  postProcessModel: string;
}

const configUrl = new URL("../dictum.config.json", import.meta.url);

const raw = JSON.parse(await Deno.readTextFile(configUrl)) as Partial<DictumConfig>;

if (typeof raw.serverBaseUrl !== "string" || raw.serverBaseUrl.length === 0) {
  throw new Error("dictum.config.json is missing serverBaseUrl");
}
if (typeof raw.postProcessModel !== "string" || raw.postProcessModel.length === 0) {
  throw new Error("dictum.config.json is missing postProcessModel");
}

export const config: DictumConfig = {
  serverBaseUrl: raw.serverBaseUrl.replace(/\/+$/, ""),
  postProcessModel: raw.postProcessModel,
};

/**
 * The path prefix the server mounts, derived from the shared base URL. A
 * central deployment changes the host and this still resolves to the same
 * routes, so the desktop app and the server stay in step from one edit.
 */
export const basePath = new URL(config.serverBaseUrl).pathname.replace(/\/+$/, "");

/** Port the starter binds, taken from the shared base URL. */
export const port = Number(new URL(config.serverBaseUrl).port || "8000");

export const MODEL_MIRROR_PREFIX = `${basePath}/api/hf`;
export const POST_PROCESS_PREFIX = `${basePath}/api/post-process`;
