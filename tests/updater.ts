/**
 * 更新检查的错误翻译。
 *
 * 这一页钉的是一件很容易被当成小事的事：**`latest.json` 不存在和断网，
 * 插件给的是同一句话**。
 *
 * 插件对任何非 2xx 都只是记一条日志，最后统一抛 `Error::ReleaseNotFound`
 * ——"Could not fetch a valid release JSON from the remote"。所以
 *
 *   - 一版都没发（`/releases/latest/download/latest.json` 404）
 *   - 最新那版被标成了 pre-release / draft（同上，`latest` 跳过它）
 *   - 真的没网
 *
 * 三种情况在代码里长得一模一样。不拆开的话，第一种会告诉用户"检查你的网络"
 * —— 第一版发布时就踩了：release 页面明明在，点 Check for updates 报网络错误。
 *
 * 反过来也不能过度拆分：`TargetNotFound`（feed 在、但没给这个架构出包）如果
 * 被归进"还没发布"，排查的人会去翻发布记录，而问题其实在 `platforms` 里。
 */

import { describeUpdateError } from "../src/platform/updater";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );

const NO_FEED = "No update feed at this address — nothing has been published yet.";
const NO_NETWORK = "Could not reach the update server — check your connection.";
const BAD_SIGNATURE = "The update failed signature verification — it was not installed.";

// ---- 1. feed 不存在（404 / 非 2xx 的统一措辞）----
eq(
  describeUpdateError(new Error("Could not fetch a valid release JSON from the remote")),
  NO_FEED,
  "插件原话 -> 说成 feed 不存在，不是网络问题",
);
eq(describeUpdateError(new Error("HTTP 404")), NO_FEED, "带状态码 404 也认");
eq(
  describeUpdateError(new Error("release not found")),
  NO_FEED,
  "小写写法也认（大小写不敏感）",
);

// ---- 2. 真断网 ----
eq(
  describeUpdateError(new Error("error sending request for url (https://example.com): connection refused")),
  NO_NETWORK,
  "connection refused -> 网络",
);
eq(describeUpdateError(new Error("dns error: failed to lookup address")), NO_NETWORK, "DNS 失败 -> 网络");
eq(describeUpdateError(new Error("request timed out")), NO_NETWORK, "超时 -> 网络");

// ---- 3. 顺序：两条都像的时候，404 先判 ----
// "failed to fetch" 是网络词，但句子里有 404 —— 发布缺失比网络更能解释它
eq(
  describeUpdateError(new Error("failed to fetch: 404 from https://example.com")),
  NO_FEED,
  "既像网络又像 404 时，按 404 处理",
);

// ---- 4. 签名 ----
eq(
  describeUpdateError(new Error("signature verification failed: invalid minisign signature")),
  BAD_SIGNATURE,
  "验签失败要明说没装",
);

// ---- 5. 不该被吞掉的：feed 在但缺这个平台 ----
const targetMissing = "the platform `windows-x86_64` was not found in the response `platforms` object";
eq(
  describeUpdateError(new Error(targetMissing)),
  targetMissing,
  "缺平台 -> 原样透出，别归进“还没发布”",
);

// ---- 6. 不认识的错误原样透出，不做二次加工 ----
eq(describeUpdateError(new Error("boom")), "boom", "未知错误原样返回");
eq(describeUpdateError("plain string"), "plain string", "抛字符串也不炸");
eq(describeUpdateError(null), "null", "抛 null 也不炸");

// ---- 7. 浏览器里根本没有插件 ----
const { checkForUpdate } = await import("../src/platform/updater");
const state = await checkForUpdate();
eq(state.status, "error", "非 Tauri 环境返回 error 而不是抛异常");
eq(
  state.status === "error" ? state.message : null,
  "Updates only work in the installed app.",
  "非 Tauri 环境给出明确说明",
);

document.getElementById("out").innerHTML = lines
  .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
  .join("\n");
window.__done = true;
