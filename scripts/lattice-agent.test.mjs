/**
 * `lattice-agent` 的客户端测试。
 *
 * 它测的不是 Rust 那一半（那个跑在 Tauri 里，起不来），而是**客户端发出去的
 * 东西对不对**：请求形状、Bearer 头、失败时的退出码、以及三种"连不上"的
 * 报错是不是各自说清楚了。
 *
 * 办法是起一个假端点，说同一套协议，把 `APPDATA` 指到一个临时目录，
 * 然后把 CLI 当子进程跑。这样连 `endpoint.json` 的读法一起测到了。
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
// 用 fileURLToPath 而不是 URL.pathname：这台机器的路径里有空格，
// pathname 会给出 %20，子进程就找不到文件
const CLI = fileURLToPath(new URL("./lattice-agent.mjs", import.meta.url));
const TOKEN = "a".repeat(64);

/** 假端点：记录收到的每个请求，按 op 回话 */
function startStub() {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const entry = {
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : null,
      };
      seen.push(entry);

      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, code: "unauthorized", error: "wrong token" }));
        return;
      }
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, app: "lattice" }));
        return;
      }
      const { op, action } = entry.body ?? {};
      if (op === "state") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: { placements: [], theme: "dark" } }));
        return;
      }
      if (op === "act" && action === "widget.grant") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: false, code: "forbidden", error: "widget.grant is never available to an agent" }),
        );
        return;
      }
      if (op === "act") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: { action, echo: entry.body.args ?? null } }));
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "bad_request", error: "unknown op" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, seen, port });
    });
  });
}

/** 造一个假的 %APPDATA%\com.iron-tom.lattice\agent */
function makeAppData(port, token = TOKEN) {
  const root = mkdtempSync(join(tmpdir(), "lattice-agent-"));
  const dir = join(root, "com.iron-tom.lattice", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "endpoint.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}/rpc`,
      health: `http://127.0.0.1:${port}/health`,
      port,
      token,
    }),
  );
  return root;
}

function cli(appData, args) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, APPDATA: appData },
    // 失败用例要读 stderr，所以不让 execFile 直接抛
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
  );
}

const stub = await startStub();
const appData = makeAppData(stub.port);

after(() => {
  stub.server.close();
  rmSync(appData, { recursive: true, force: true });
});

test("ping 打通之后打印健康响应", async () => {
  const result = await cli(appData, ["ping"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, app: "lattice" });
});

test("state 把 result 原样打印出来", async () => {
  const result = await cli(appData, ["state"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { placements: [], theme: "dark" });
});

test("state 带上了 Bearer 头，body 是 op=state", async () => {
  stub.seen.length = 0;
  await cli(appData, ["state"]);
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(stub.seen[0].body, { op: "state" });
});

test("act 把动作名和 --args 一起送到", async () => {
  stub.seen.length = 0;
  const result = await cli(appData, ["act", "theme.set", "--args", '{"theme":"dark"}']);
  assert.equal(result.code, 0);
  assert.deepEqual(stub.seen[0].body, { op: "act", action: "theme.set", args: { theme: "dark" } });
  assert.deepEqual(JSON.parse(result.stdout), { action: "theme.set", echo: { theme: "dark" } });
});

test("act 不带 --args 时 args 是 null，不是空对象", async () => {
  stub.seen.length = 0;
  await cli(appData, ["act", "widgets.pause"]);
  assert.equal(stub.seen[0].body.args, null);
});

test("被拒绝的动作：退出码 1，错误进 stderr，stdout 干净", async () => {
  const result = await cli(appData, ["act", "widget.grant", "--args", '{"widgetId":"x"}']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "stdout 必须干净，否则 | jq 会吃到错误信息");
  assert.match(result.stderr, /forbidden/);
  assert.match(result.stderr, /never available/);
});

test("--args 不是 JSON：本地就拒，不发请求", async () => {
  stub.seen.length = 0;
  const result = await cli(appData, ["act", "theme.set", "--args", "{nope"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--args is not valid JSON/);
  assert.equal(stub.seen.length, 0);
});

test("令牌不对：说清楚是令牌被换了，不是没开", async () => {
  const wrong = makeAppData(stub.port, "b".repeat(64));
  const result = await cli(wrong, ["state"]);
  rmSync(wrong, { recursive: true, force: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /token .* was rejected/);
});

test("没有 endpoint.json：三条可能的原因都列出来", async () => {
  const empty = mkdtempSync(join(tmpdir(), "lattice-agent-empty-"));
  const result = await cli(empty, ["state"]);
  rmSync(empty, { recursive: true, force: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not running/);
  assert.match(result.stderr, /Agent access is off/);
  assert.match(result.stderr, /never been started/);
});

test("端点文件指向一个没人听的端口：报「端口是陈的」", async () => {
  const stale = makeAppData(1);
  const result = await cli(stale, ["state"]);
  rmSync(stale, { recursive: true, force: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stale/);
});

test("未知命令给出 help 的提示", async () => {
  const result = await cli(appData, ["explode"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command/);
  assert.match(result.stderr, /help/);
});
