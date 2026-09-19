/**
 * Passive HTTP tracer, preloaded with `node --import`.
 *
 * Taps http(s).request so every outbound LLM API call is recorded to the
 * JSONL file named by CA_HTTP_TRACE — without modifying agent code and
 * without changing stream flow (response events are observed by wrapping
 * `emit`, never by attaching 'data' listeners).
 *
 * One record per request: timing (headers/first byte/end), status, rate-limit
 * headers, request shape (model, message count, tools, payload size) and
 * response shape (usage, finish reason, tool calls, content length). Never
 * records request headers (API keys live there).
 */
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";

const TRACE_FILE = process.env.CA_HTTP_TRACE;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const SNIPPET_CHARS = 400;
const TOOL_OUTPUT_SNIPPET_CHARS = 2000;

let seq = 0;

function write(record) {
  try {
    appendFileSync(TRACE_FILE, JSON.stringify(record) + "\n");
  } catch {
    // Tracing must never affect the agent.
  }
}

function requestTarget(args) {
  const [first, second] = args;
  const opts = typeof first === "string" || first instanceof URL ? second ?? {} : first ?? {};
  const url = typeof first === "string" || first instanceof URL ? new URL(first) : null;
  return {
    host: url?.hostname ?? opts.hostname ?? opts.host ?? "",
    path: url ? url.pathname : (opts.path ?? "").split("?")[0],
    method: opts.method ?? "GET",
  };
}

function summarizeRequestBody(raw) {
  try {
    const body = JSON.parse(raw);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const roles = {};
    for (const m of messages) roles[m.role] = (roles[m.role] ?? 0) + 1;
    // The newest messages are what changed since the previous call: the
    // assistant's last action and the tool output / nudge it got back.
    // Earlier ones are already captured by the previous records.
    const newest = messages.slice(-2).map((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return { role: m.role, chars: text.length, snippet: text.slice(0, TOOL_OUTPUT_SNIPPET_CHARS) };
    });
    return {
      newest_messages: newest,
      model: body.model,
      stream: body.stream ?? false,
      max_tokens: body.max_tokens ?? body.max_completion_tokens,
      n_messages: messages.length,
      roles,
      n_tools: Array.isArray(body.tools) ? body.tools.length : 0,
      system_chars: messages
        .filter((m) => m.role === "system")
        .reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0),
    };
  } catch {
    return { unparsed: true };
  }
}

function summarizeResponseBody(raw, contentType) {
  const out = { content_chars: 0, tool_calls: [], finish_reason: null, usage: null, error: null };
  const absorbChoice = (choice) => {
    if (!choice) return;
    const msg = choice.message ?? choice.delta ?? {};
    if (typeof msg.content === "string") {
      if (out.content_chars < SNIPPET_CHARS) out.content_snippet = (out.content_snippet ?? "") + msg.content;
      out.content_chars += msg.content.length;
    }
    for (const tc of msg.tool_calls ?? []) {
      const idx = tc.index ?? out.tool_calls.length;
      const entry = (out.tool_calls[idx] ??= { name: "", args_chars: 0, args_snippet: "" });
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) {
        entry.args_chars += tc.function.arguments.length;
        if (entry.args_snippet.length < SNIPPET_CHARS) entry.args_snippet += tc.function.arguments;
      }
    }
    if (choice.finish_reason) out.finish_reason = choice.finish_reason;
  };
  const absorb = (obj) => {
    if (obj.error) out.error = obj.error;
    (obj.choices ?? []).forEach(absorbChoice);
    const usage = obj.usage ?? obj.x_groq?.usage;
    if (usage) out.usage = usage;
  };

  if ((contentType ?? "").includes("event-stream")) {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        absorb(JSON.parse(data));
      } catch {
        /* partial line */
      }
    }
  } else {
    try {
      absorb(JSON.parse(raw));
    } catch {
      out.raw_snippet = raw.slice(0, SNIPPET_CHARS);
    }
  }
  if (out.content_snippet) out.content_snippet = out.content_snippet.slice(0, SNIPPET_CHARS);
  for (const tc of out.tool_calls) tc.args_snippet = tc.args_snippet.slice(0, SNIPPET_CHARS);
  return out;
}

function pickHeaders(headers) {
  const picked = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.startsWith("x-ratelimit") || k === "retry-after" || k === "content-type" || k === "x-request-id") {
      picked[k] = v;
    }
  }
  return picked;
}

function wrap(mod) {
  const original = mod.request;
  mod.request = function tracedRequest(...args) {
    const target = requestTarget(args);
    const req = original.apply(this, args);
    if (!TRACE_FILE) return req;

    const id = ++seq;
    const t0 = Date.now();
    const reqChunks = [];
    let reqBytes = 0;
    const record = { id, host: target.host, path: target.path, method: target.method, t_start: new Date(t0).toISOString() };
    let written = false;
    const finish = (extra) => {
      if (written) return;
      written = true;
      write({ ...record, ...extra, total_ms: Date.now() - t0 });
    };

    const origWrite = req.write;
    req.write = function (chunk, ...rest) {
      if (chunk && reqBytes < MAX_CAPTURE_BYTES) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        reqChunks.push(buf);
        reqBytes += buf.length;
      }
      return origWrite.call(this, chunk, ...rest);
    };
    const origEnd = req.end;
    req.end = function (chunk, ...rest) {
      if (chunk && typeof chunk !== "function") {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        reqChunks.push(buf);
        reqBytes += buf.length;
      }
      const raw = Buffer.concat(reqChunks).toString("utf8");
      record.request_bytes = reqBytes;
      record.request = summarizeRequestBody(raw);
      return origEnd.call(this, chunk, ...rest);
    };

    req.on("error", (err) => finish({ outcome: "request_error", error_code: err.code, error_message: err.message }));

    req.on("response", (res) => {
      record.status = res.statusCode;
      record.headers_ms = Date.now() - t0;
      record.response_headers = pickHeaders(res.headers);
      const resChunks = [];
      let resBytes = 0;
      let firstByte = true;
      const origEmit = res.emit;
      res.emit = function (event, ...eargs) {
        if (event === "data") {
          if (firstByte) {
            record.first_byte_ms = Date.now() - t0;
            firstByte = false;
          }
          const buf = Buffer.isBuffer(eargs[0]) ? eargs[0] : Buffer.from(eargs[0]);
          if (resBytes < MAX_CAPTURE_BYTES) resChunks.push(buf);
          resBytes += buf.length;
        } else if (event === "end" || event === "close" || event === "error") {
          const raw = Buffer.concat(resChunks).toString("utf8");
          finish({
            outcome: event === "end" ? "complete" : event === "error" ? "response_error" : "closed_before_end",
            response_bytes: resBytes,
            response: summarizeResponseBody(raw, res.headers["content-type"]),
          });
        }
        return origEmit.call(this, event, ...eargs);
      };
    });
    return req;
  };
  // http.get/https.get call the module-internal request, not the export — rebind.
  mod.get = function tracedGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

wrap(http);
wrap(https);
