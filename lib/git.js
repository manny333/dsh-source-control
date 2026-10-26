// src/host/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
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
function assertRoot(root) {
  if (typeof root !== "string" || root === "" || !isAbsolute(root)) {
    throw Object.assign(new Error(`dsh-source-control: invalid workspace path "${root}"`), { code: "invalid-root" });
  }
  return root;
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
export {
  assertBranchName,
  assertRoot,
  branchArgs,
  git,
  literalPath,
  logArgs,
  parseBranches,
  parseLog,
  parseStatus,
  redact,
  statusArgs
};
//# sourceMappingURL=git.js.map
