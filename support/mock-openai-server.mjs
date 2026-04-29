#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const options = parseArgs(process.argv.slice(2));
const marker = options.marker ?? "KOVA_AGENT_OK";
const requestLog = options.requestLog ?? null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeSse(res, events) {
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream"
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function responseEvents(text) {
  return [
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_kova_1", role: "assistant", content: [], status: "in_progress" }
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_kova_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }]
      }
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          total_tokens: 12,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    }
  ];
}

function writeChatCompletion(res, stream) {
  if (stream) {
    writeSse(res, [
      {
        id: "chatcmpl_kova",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: marker } }]
      },
      {
        id: "chatcmpl_kova",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }
    ]);
    return;
  }

  writeJson(res, 200, {
    id: "chatcmpl_kova",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: marker }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: [{ id: "gpt-5.5", object: "model", owned_by: "kova" }]
    });
    return;
  }

  const bodyText = await readBody(req);
  if (requestLog) {
    fs.appendFileSync(requestLog, `${JSON.stringify({ method: req.method, path: url.pathname, body: bodyText })}\n`);
  }

  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    if (body.stream === false) {
      writeJson(res, 200, {
        id: "resp_kova",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_kova_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: marker, annotations: [] }]
          }
        ],
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 }
      });
      return;
    }
    writeSse(res, responseEvents(marker));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    writeChatCompletion(res, body.stream !== false);
    return;
  }

  writeJson(res, 404, { error: { message: `unhandled mock route: ${req.method} ${url.pathname}` } });
});

server.listen(Number(options.port ?? 0), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    throw new Error("mock server did not expose a port");
  }
  if (options.portFile) {
    fs.writeFileSync(options.portFile, `${port}\n`, "utf8");
  }
  console.log(`kova mock openai listening on ${port}`);
});

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    marker: parsed.marker,
    port: parsed.port,
    portFile: parsed.portfile,
    requestLog: parsed.requestlog
  };
}
