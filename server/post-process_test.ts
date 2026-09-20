/**
 * Post-processing gateway tests.
 *
 * The starter credential is public, so the envelope and the auth check are the
 * only things standing between an accidentally-exposed server and a paid
 * arbitrary-prompt relay. These tests pin that boundary: what a client may
 * influence, and what it may not.
 *
 * No test here reaches OpenRouter. `buildUpstreamBody` is exercised directly,
 * and the handler tests stop at the auth and validation gates.
 */

import { assertEquals, assertFalse } from "@std/assert";
import { buildUpstreamBody, GATEWAY_API_KEY } from "./post-process.ts";
import { config } from "./config.ts";

const messages = [{ role: "user", content: "fix this transcript" }];

function built(payload: unknown): Record<string, unknown> {
  const result = buildUpstreamBody(payload);
  if ("error" in result) throw new Error(`unexpected rejection: ${result.error}`);
  return JSON.parse(result.body);
}

function rejection(payload: unknown): string {
  const result = buildUpstreamBody(payload);
  if (!("error" in result)) throw new Error("expected a rejection");
  return result.error;
}

Deno.test("the configured model is forced, whatever the client asks for", () => {
  const body = built({ model: "openai/gpt-4o", messages });
  assertEquals(body.model, config.postProcessModel);
});

Deno.test("a request that names no model still gets the configured one", () => {
  assertEquals(built({ messages }).model, config.postProcessModel);
});

Deno.test("streaming is forced off", () => {
  // The desktop app parses a single JSON response; a streamed reply would also
  // let a client hold an upstream connection open.
  assertEquals(built({ messages, stream: true }).stream, false);
});

Deno.test("client-controlled options are dropped", () => {
  const body = built({
    messages,
    temperature: 2,
    max_tokens: 100000,
    tools: [{ type: "function" }],
    tool_choice: "auto",
    plugins: [{ id: "web" }],
    provider: { order: ["expensive"] },
    top_p: 0.1,
    n: 20,
    user: "someone",
  });

  assertEquals(Object.keys(body).sort(), ["messages", "model", "stream"]);
});

Deno.test("the structured-output schema is forwarded", () => {
  // Dictum's normal post-processing path asks for a strict JSON schema and
  // parses the result; dropping it would silently demote every dictation to
  // the legacy text fallback.
  const response_format = {
    type: "json_schema",
    json_schema: { name: "transcription_output", strict: true, schema: {} },
  };
  assertEquals(built({ messages, response_format }).response_format, response_format);
});

Deno.test("message content is passed through untouched", () => {
  const body = built({
    messages: [
      { role: "system", content: "you clean transcripts" },
      { role: "user", content: '  spaced  and "quoted" \n text  ' },
    ],
  });
  assertEquals(body.messages, [
    { role: "system", content: "you clean transcripts" },
    { role: "user", content: '  spaced  and "quoted" \n text  ' },
  ]);
});

Deno.test("only conversational roles are accepted", () => {
  assertEquals(
    rejection({ messages: [{ role: "tool", content: "x" }] }),
    "invalid_request",
  );
});

Deno.test("malformed requests are rejected", () => {
  assertEquals(rejection(null), "invalid_request");
  assertEquals(rejection("a string"), "invalid_request");
  assertEquals(rejection({}), "invalid_request");
  assertEquals(rejection({ messages: [] }), "invalid_request");
  assertEquals(rejection({ messages: "not an array" }), "invalid_request");
  assertEquals(rejection({ messages: [null] }), "invalid_request");
  assertEquals(rejection({ messages: [{ role: "user" }] }), "invalid_request");
  assertEquals(
    rejection({ messages: [{ role: "user", content: { nested: true } }] }),
    "invalid_request",
  );
});

Deno.test("an oversized conversation is rejected", () => {
  const many = Array.from({ length: 17 }, () => ({ role: "user", content: "x" }));
  assertEquals(rejection({ messages: many }), "request_too_large");
});

// --- Auth gate, through the server's own handler ---

const URL_ = "http://localhost:8000/dictum/api/post-process/chat/completions";

async function post(
  headers: HeadersInit,
  body: unknown = { messages },
): Promise<Response> {
  const { handler } = await import("./main.ts");
  return await handler(
    new Request(URL_, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

Deno.test("an unauthenticated request never reaches upstream", async () => {
  const cases: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    { authorization: GATEWAY_API_KEY }, // missing the Bearer scheme
    { authorization: "Bearer " },
    { authorization: `Bearer ${GATEWAY_API_KEY}x` },
  ];

  for (const headers of cases) {
    const response = await post(headers);
    assertEquals(response.status, 401, `expected 401 for ${JSON.stringify(headers)}`);
    await response.body?.cancel();
  }
});

Deno.test("a gateway error names no upstream detail", async () => {
  const response = await post({});
  const body = await response.json();
  assertEquals(body.error.type, "gateway_error");
  assertEquals(body.error.message, "invalid_api_key");
  assertFalse(JSON.stringify(body).toLowerCase().includes("openrouter"));
});

Deno.test("routes other than chat/completions are not served", async () => {
  const { handler } = await import("./main.ts");
  for (const path of ["/models", "/chat", "/chat/completions/extra", ""]) {
    const url = `http://localhost:8000/dictum/api/post-process${path}`;
    const response = await handler(new Request(url, { method: "POST" }));
    assertEquals(response.status, 404, `expected 404 for ${path}`);
    await response.body?.cancel();
  }
});

Deno.test("GET is refused on the completions route", async () => {
  const { handler } = await import("./main.ts");
  const response = await handler(new Request(URL_));
  assertEquals(response.status, 405);
  await response.body?.cancel();
});
