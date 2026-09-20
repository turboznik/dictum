/**
 * The Dictum post-processing gateway.
 *
 * Forwards Dictum's post-processing requests to OpenRouter over an
 * OpenAI-compatible surface, so the desktop app reaches it through the
 * inherited "Custom" provider with no new client code.
 *
 * The starter credential below is public, so this gateway is written as if it
 * were already exposed: it accepts a fixed request envelope, forces the model,
 * and never echoes OpenRouter's response text into an error or a log. Without
 * that, a server left listening on a routable interface is a paid
 * arbitrary-prompt relay.
 */

import { config, POST_PROCESS_PREFIX } from "./config.ts";

/**
 * The desktop-app-to-gateway credential.
 *
 * Deliberately hard-coded and deliberately worthless: this repository is a
 * starter kit, and an adopter is expected to replace this check with their own
 * authentication before the server leaves loopback.
 */
export const GATEWAY_API_KEY = "SAFE_FOR_TESTING";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Beyond this, a request is not a dictation being cleaned up. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 16;
const UPSTREAM_TIMEOUT_MS = 60_000;

interface ChatMessage {
  role: string;
  content: string;
}

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

function gatewayError(status: number, code: string): Response {
  // Generic by construction: OpenRouter's own error text can name models,
  // accounts and rate-limit details that a client has no business seeing.
  return new Response(
    JSON.stringify({ error: { message: code, type: "gateway_error" } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function isAuthorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(match[1], GATEWAY_API_KEY);
}

/** Constant-time compare so the starter key's length isn't probeable. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * Reduces a client request to the envelope Dictum actually sends.
 *
 * `messages` and `response_format` are kept because post-processing depends on
 * them: the desktop app asks for a strict JSON schema and parses the result.
 * `model` and `stream` are forced rather than validated. Everything else —
 * sampling, tools, plugins, provider routing — is dropped, so a client cannot
 * spend an adopter's credit on anything but the configured model.
 */
export function buildUpstreamBody(
  payload: unknown,
): { body: string } | { error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { error: "invalid_request" };
  }

  const input = payload as Record<string, unknown>;

  if (!Array.isArray(input.messages)) return { error: "invalid_request" };
  if (input.messages.length === 0) return { error: "invalid_request" };
  if (input.messages.length > MAX_MESSAGES) return { error: "request_too_large" };

  const messages: ChatMessage[] = [];
  for (const raw of input.messages) {
    if (typeof raw !== "object" || raw === null) return { error: "invalid_request" };
    const message = raw as Record<string, unknown>;
    if (typeof message.role !== "string" || !ALLOWED_ROLES.has(message.role)) {
      return { error: "invalid_request" };
    }
    if (typeof message.content !== "string") return { error: "invalid_request" };
    messages.push({ role: message.role, content: message.content });
  }

  const body: Record<string, unknown> = {
    model: config.postProcessModel,
    messages,
    stream: false,
  };

  // Structured output is the desktop app's normal path; passing the schema
  // through is what keeps it on that path instead of the legacy text fallback.
  if (input.response_format !== undefined) {
    if (typeof input.response_format !== "object" || input.response_format === null) {
      return { error: "invalid_request" };
    }
    body.response_format = input.response_format;
  }

  return { body: JSON.stringify(body) };
}

export async function handlePostProcess(
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith(`${POST_PROCESS_PREFIX}/`)) return null;

  const route = url.pathname.slice(POST_PROCESS_PREFIX.length);

  // One route only. `/models` is deliberately absent: the model is fixed, and
  // the desktop app's model picker is hidden.
  if (route !== "/chat/completions") {
    return gatewayError(404, "not_found");
  }

  if (request.method !== "POST") {
    return gatewayError(405, "method_not_allowed");
  }

  if (!isAuthorized(request)) {
    return gatewayError(401, "invalid_api_key");
  }

  const upstreamKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!upstreamKey) {
    console.error("OPENROUTER_API_KEY is not set; refusing to forward");
    return gatewayError(503, "gateway_not_configured");
  }

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return gatewayError(413, "request_too_large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return gatewayError(400, "invalid_json");
  }

  const built = buildUpstreamBody(payload);
  if ("error" in built) {
    return gatewayError(400, built.error);
  }

  const abort = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${upstreamKey}`,
        "content-type": "application/json",
        // OpenRouter attribution headers; neither carries user content.
        "http-referer": "https://github.com/turboznik/dictum",
        "x-title": "Dictum",
      },
      body: built.body,
      signal: abort,
    });
  } catch (error) {
    // Never log the body — it holds a transcript.
    console.error(
      "Upstream request failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return gatewayError(502, "upstream_unavailable");
  }

  if (!upstream.ok) {
    // Status only. OpenRouter's message could name the account or the model.
    console.error(`Upstream returned ${upstream.status}`);
    return gatewayError(upstream.status === 429 ? 429 : 502, "upstream_error");
  }

  // Pass the completion straight back: the desktop app parses it as an
  // ordinary OpenAI-compatible response. Streaming it avoids holding the
  // transcript in gateway memory any longer than the socket needs.
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
