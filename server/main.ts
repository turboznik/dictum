/**
 * The Dictum server: entry point.
 *
 * Hosts the model mirror and the post-processing gateway on one origin, the
 * one recorded in `dictum.config.json` and compiled into the desktop app.
 *
 * The starter binds loopback on purpose. The gateway's credential is public
 * (`SAFE_FOR_TESTING`) and the mirror is unauthenticated, so an adopter is
 * expected to add authentication before moving this onto a network.
 */

import { load } from "@std/dotenv";
import { fromFileUrl } from "@std/path";
import { basePath, config, port } from "./config.ts";
import { handleModelMirror } from "./hf.ts";
import { handlePostProcess } from "./post-process.ts";

// server/.env holds OPENROUTER_API_KEY and is never committed.
await load({
  envPath: fromFileUrl(new URL("./.env", import.meta.url)),
  export: true,
});

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const response = await route(request, url);

  // Method, path, status and range only. Never a body: a post-processing
  // request carries a transcript, and a model download carries model bytes.
  console.log(
    `${request.method} ${url.pathname} -> ${response.status}` +
      (request.headers.get("range") ? ` [${request.headers.get("range")}]` : ""),
  );

  return response;
}

async function route(request: Request, url: URL): Promise<Response> {
  const mirrored = await handleModelMirror(request, url);
  if (mirrored) return mirrored;

  const processed = await handlePostProcess(request, url);
  if (processed) return processed;

  if (url.pathname === `${basePath}/health`) {
    return Response.json({ status: "ok", service: "dictum-server" });
  }

  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

if (import.meta.main) {
  console.log(`Dictum server listening on ${config.serverBaseUrl}`);
  console.log(`  model mirror          ${basePath}/api/hf`);
  console.log(`  post-processing       ${basePath}/api/post-process`);
  console.log(`  health                ${basePath}/health`);

  if (!Deno.env.get("OPENROUTER_API_KEY")) {
    console.warn("  warning: OPENROUTER_API_KEY is not set; post-processing will fail");
  }

  Deno.serve({ port, hostname: "127.0.0.1" }, handler);
}

export { handler };
