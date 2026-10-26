// src/host/routes.ts
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

// src/host/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var MAX_BUFFER = 16 * 1024 * 1024;
function redact(text) {
  return text.replace(/https?:\/\/[^\s@]*@/gi, "https://[credentials]@");
}
function gitEnv() {
  return {
    ...process.env,
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C"
  };
}
async function git(args, cwd, signal) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: gitEnv(),
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      signal
    });
    return String(result.stdout ?? "");
  } catch (error) {
    const stderr = redact(String(error?.stderr ?? error?.message ?? error)).trim();
    const message = stderr.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
    const wrapped = new Error(message || "git failed");
    wrapped.code = "git-failed";
    throw wrapped;
  }
}
function literalPath(path) {
  return `:(literal)${path}`;
}
function letter(ch) {
  return ch === "." || ch === " " ? null : ch;
}
function addChange(status, xy, path, origPath) {
  if (path === "") return;
  const [x, y] = [xy[0] ?? ".", xy[1] ?? "."];
  const staged = letter(x);
  const worktree = letter(y);
  if (staged !== null) status.staged.push({ path, origPath, status: staged, staged: true });
  if (worktree !== null) status.unstaged.push({ path, origPath, status: worktree, staged: false });
}
function afterFields(line, count) {
  let index = 0;
  for (let seen = 0; seen < count; seen += 1) {
    index = line.indexOf(" ", index);
    if (index < 0) return "";
    index += 1;
  }
  return line.slice(index);
}
function statusArgs() {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}
function parseStatus(raw, root = "") {
  const status = {
    root,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    mergeState: "none",
    operationInProgress: false
  };
  const nul = raw.includes("\0");
  const records = nul ? raw.split("\0") : raw.split(/\r?\n/);
  for (let i = 0; i < records.length; i += 1) {
    const line = records[i];
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      status.branch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }
    const kind = line[0];
    if (kind === "1") {
      addChange(status, line.slice(2, 4), afterFields(line, 8));
    } else if (kind === "2") {
      const current = afterFields(line, 9);
      if (nul) {
        const original = records[i + 1] ?? "";
        if (original !== "") i += 1;
        addChange(status, line.slice(2, 4), current, original || void 0);
      } else {
        const tab = current.indexOf("	");
        if (tab < 0) addChange(status, line.slice(2, 4), current);
        else addChange(status, line.slice(2, 4), current.slice(0, tab), current.slice(tab + 1));
      }
    } else if (kind === "u") {
      status.mergeState = "unmerged";
      status.operationInProgress = true;
      status.unstaged.push({ path: afterFields(line, 10), status: "U", staged: false });
    } else if (kind === "?") {
      const path = afterFields(line, 1);
      if (path !== "") status.untracked.push(path);
    }
  }
  return status;
}
var LOG_SEP = "";
var FIELD_SEP = "";
function parseLog(raw) {
  return raw.split(LOG_SEP).map((chunk) => chunk.replace(/^\r?\n/, "")).filter((chunk) => chunk.trim() !== "").map((chunk) => {
    const [sha, shortSha, subject, author, date, refs] = chunk.split(FIELD_SEP);
    return { sha: sha ?? "", shortSha: shortSha ?? "", subject: subject ?? "", author: author ?? "", date: date ?? "", refs: refs ?? "" };
  });
}
function logArgs(limit) {
  const count = Math.max(1, Math.min(200, Math.floor(limit || 30)));
  return ["log", `-n${count}`, "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e"];
}
function branchArgs() {
  return [
    "for-each-ref",
    "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
    "refs/heads",
    "refs/remotes"
  ];
}
var AHEAD_RE = /ahead (\d+)/;
var BEHIND_RE = /behind (\d+)/;
function parseBranches(raw) {
  const locals = [];
  const remotes = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "") continue;
    const [refname = "", head = "", upstream = "", track = ""] = line.split("\0");
    const ahead = Number(AHEAD_RE.exec(track)?.[1] ?? 0);
    const behind = Number(BEHIND_RE.exec(track)?.[1] ?? 0);
    const gone = track.includes("gone");
    if (refname.startsWith("refs/heads/")) {
      locals.push({
        name: refname.slice("refs/heads/".length),
        kind: "local",
        remote: null,
        branch: null,
        current: head.trim() === "*",
        upstream: upstream.trim() || null,
        ahead,
        behind,
        gone
      });
      continue;
    }
    if (!refname.startsWith("refs/remotes/")) continue;
    const rest = refname.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const remote = rest.slice(0, slash);
    const branch = rest.slice(slash + 1);
    if (branch === "HEAD") continue;
    remotes.push({
      name: rest,
      kind: "remote",
      remote,
      branch,
      current: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      gone: false
    });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  locals.sort((a, b) => a.current === b.current ? byName(a, b) : a.current ? -1 : 1);
  remotes.sort(byName);
  return [...locals, ...remotes];
}
var INVALID_BRANCH_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;
function assertBranchName(name) {
  const value = typeof name === "string" ? name : "";
  const invalid = value === "" || value.length > 255 || INVALID_BRANCH_CHARS.test(value) || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("//") || value.includes("@{") || value.split("/").some((segment) => segment.endsWith(".lock"));
  if (invalid) {
    throw Object.assign(new Error(`dsh-source-control: invalid branch name "${value}"`), {
      code: "invalid-branch"
    });
  }
  return value;
}

// src/host/commit-message.ts
var CommitMessageError = class extends Error {
  constructor(message, status = 502) {
    super(redact(message));
    this.name = "CommitMessageError";
    this.status = status;
  }
};

// src/host/routes.ts
var STATE_ROUTE = "/dsh-source-control/state";
var ACTION_ROUTE = "/dsh-source-control/action";
var MESSAGE_ROUTE = "/dsh-source-control/message";
var MESSAGE_TIMEOUT_MS = 3e4;
var MAX_BODY_BYTES = 64 * 1024;
var MAX_LIMIT = 200;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function hostnameOf(host) {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close > 0 ? trimmed.slice(0, close + 1) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
}
function policyViolation(req) {
  const rawHost = req.headers.host;
  if (typeof rawHost !== "string" || rawHost.trim() === "") {
    return { status: 403, message: "a Host header is required" };
  }
  const host = rawHost.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) {
    return { status: 403, message: "requests must address the loopback interface" };
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { status: 403, message: "cross-origin requests are refused" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { status: 403, message: "cross-origin requests are refused" };
    }
    if (parsed.host !== host) {
      return { status: 403, message: "cross-origin requests are refused" };
    }
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return { status: 403, message: "cross-site requests are refused" };
  }
  return null;
}
function isJson(req) {
  const raw = req.headers["content-type"];
  return typeof raw === "string" && /^application\/json\b/i.test(raw.trim());
}
function sendJson(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}
`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store"
  });
  res.end(payload);
}
function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: redact(message) });
}
async function rootOf(raw) {
  if (typeof raw !== "string" || raw === "" || !isAbsolute(raw)) {
    throw new Error("the root parameter must be an absolute path");
  }
  const info = await stat(raw);
  if (!info.isDirectory()) throw new Error("the root parameter is not a directory");
  return raw;
}
function repoPathOf(raw) {
  if (typeof raw !== "string" || raw === "" || isAbsolute(raw) || raw.includes("\0")) {
    throw new Error("the path parameter must be a relative repository path");
  }
  return raw;
}
async function snapshot(root, limit) {
  const [rawStatus, rawLog, rawBranches] = await Promise.all([
    git(statusArgs(), root),
    // A repository without commits still reports a useful status.
    git(logArgs(limit), root).catch(() => ""),
    git(branchArgs(), root).catch(() => "")
  ]);
  return {
    ok: true,
    status: parseStatus(rawStatus, root),
    log: parseLog(rawLog),
    branches: parseBranches(rawBranches)
  };
}
async function refExists(root, ref) {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], root);
    return true;
  } catch {
    return false;
  }
}
async function isUntracked(root, path) {
  const raw = await git(["status", "--porcelain=v1", "-z", "--", literalPath(path)], root);
  return raw.startsWith("??");
}
function limitOf(url) {
  const raw = Number(url.searchParams.get("limit") ?? "30");
  return Number.isFinite(raw) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw))) : 30;
}
async function serveState(req, res) {
  const violation = policyViolation(req);
  if (violation) {
    fail(res, violation.status, violation.message);
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const root = await rootOf(url.searchParams.get("root"));
    sendJson(res, 200, await snapshot(root, limitOf(url)));
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error));
  }
}
async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("malformed JSON body");
  }
}
async function serveAction(req, res) {
  const violation = policyViolation(req);
  if (violation) {
    fail(res, violation.status, violation.message);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (!isJson(req)) {
    fail(res, 415, "the action route only accepts application/json");
    return;
  }
  try {
    const body = await readJson(req);
    const root = await rootOf(typeof body.root === "string" ? body.root : null);
    const action = String(body.action ?? "");
    const limit = 30;
    switch (action) {
      case "stage":
        await git(["add", "--", literalPath(repoPathOf(body.path))], root);
        break;
      case "unstage":
        await git(["restore", "--staged", "--", literalPath(repoPathOf(body.path))], root);
        break;
      case "stageAll":
        await git(["add", "-A"], root);
        break;
      case "unstageAll":
        await git(["reset"], root);
        break;
      case "commit": {
        const message = String(body.message ?? "").trim();
        if (message === "") throw new Error("the commit message is empty");
        await git(["commit", "-m", message], root);
        break;
      }
      case "push":
        await git(["push"], root);
        break;
      case "pull":
        await git(["pull", "--ff-only"], root);
        break;
      case "publish":
        await git(["push", "-u", "origin", "HEAD"], root);
        break;
      case "checkout": {
        const name = assertBranchName(body.name);
        if (body.kind !== "remote") {
          await git(["switch", name], root);
          break;
        }
        const slash = name.indexOf("/");
        if (slash <= 0 || slash === name.length - 1) {
          throw new Error(`invalid remote branch "${name}"`);
        }
        const local = assertBranchName(name.slice(slash + 1));
        if (await refExists(root, `refs/heads/${local}`)) {
          await git(["switch", local], root);
          break;
        }
        try {
          await git(["switch", "-c", local, "--track", name], root);
        } catch {
          if (await refExists(root, `refs/heads/${local}`)) await git(["switch", local], root);
          else await git(["switch", "-c", local, name], root);
        }
        break;
      }
      case "discard": {
        const path = repoPathOf(body.path);
        const paths = [literalPath(path)];
        if (typeof body.origPath === "string" && body.origPath !== "") {
          paths.push(literalPath(repoPathOf(body.origPath)));
        }
        if (await isUntracked(root, path)) {
          await git(["clean", "-f", "-d", "--", ...paths], root);
        } else {
          await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], root);
        }
        break;
      }
      case "discardAll": {
        try {
          await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], root);
        } catch {
          await git(["reset"], root).catch(() => {
          });
        }
        await git(["clean", "-f", "-d"], root);
        break;
      }
      case "fetch":
        try {
          await git(["fetch", "--prune"], root);
        } catch {
        }
        break;
      default:
        throw new Error(`unknown action "${action}"`);
    }
    sendJson(res, 200, await snapshot(root, limit));
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error));
  }
}
async function serveMessage(req, res, generate, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const violation = policyViolation(req);
  if (violation) {
    fail(res, violation.status, violation.message);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (!isJson(req)) {
    fail(res, 415, "the message route only accepts application/json");
    return;
  }
  if (typeof generate !== "function") {
    fail(res, 503, "no model service is mounted in this profile");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = await readJson(req);
    const root = await rootOf(typeof body.root === "string" ? body.root : null);
    const route = {
      provider: typeof body.provider === "string" ? body.provider.slice(0, 200) : void 0,
      model: typeof body.model === "string" ? body.model.slice(0, 200) : void 0
    };
    const result = await generate(root, controller.signal, route);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    if (controller.signal.aborted) {
      fail(res, 504, "the model call timed out");
      return;
    }
    const status = error instanceof CommitMessageError ? error.status : 400;
    fail(res, status, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
export {
  ACTION_ROUTE,
  MESSAGE_ROUTE,
  MESSAGE_TIMEOUT_MS,
  STATE_ROUTE,
  hostnameOf,
  policyViolation,
  serveAction,
  serveMessage,
  serveState
};
//# sourceMappingURL=routes.js.map
