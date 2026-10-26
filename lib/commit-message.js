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

// src/host/commit-message.ts
var CommitMessageError = class extends Error {
  constructor(message, status = 502) {
    super(redact(message));
    this.name = "CommitMessageError";
    this.status = status;
  }
};
var MIN_DIFF_CHARS = 1e3;
var MAX_DIFF_CHARS = 6e4;
var DEFAULT_DIFF_CHARS = 12e3;
var MAX_FILES = 60;
function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function normalizeSettings(raw = {}) {
  return {
    provider: typeof raw?.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw?.model === "string" ? raw.model.trim() : "",
    maxDiffChars: clampInt(raw?.maxDiffChars, MIN_DIFF_CHARS, MAX_DIFF_CHARS, DEFAULT_DIFF_CHARS),
    language: typeof raw?.language === "string" ? raw.language.trim() : ""
  };
}
function providerIds(llm) {
  try {
    const providers = llm?.listProviders?.() ?? [];
    const ids = [];
    for (const entry of providers) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (typeof id === "string" && id !== "") ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}
async function resolveRoute(llm, settings, override = {}) {
  const wantedProvider = (override.provider ?? "").trim() || settings.provider;
  const wantedModel = (override.model ?? "").trim() || settings.model;
  const ids = providerIds(llm);
  if (wantedProvider !== "" && wantedModel !== "") {
    if (ids.length > 0 && !ids.includes(wantedProvider)) {
      throw new CommitMessageError(`the provider "${wantedProvider}" is not mounted`, 503);
    }
    return { provider: wantedProvider, model: wantedModel };
  }
  if (ids.length === 0) {
    throw new CommitMessageError("no model provider is mounted in this profile", 503);
  }
  if (wantedProvider !== "" && !ids.includes(wantedProvider)) {
    throw new CommitMessageError(`the configured provider "${wantedProvider}" is not mounted`, 503);
  }
  const candidates = wantedProvider === "" ? ids : [wantedProvider];
  for (const provider of candidates) {
    if (wantedModel !== "") return { provider, model: wantedModel };
    let models = [];
    try {
      models = await llm.listModels(provider) ?? [];
    } catch {
      models = [];
    }
    const first = models.find((model) => typeof model?.id === "string" && model.id !== "");
    if (first) return { provider, model: first.id };
  }
  throw new CommitMessageError(
    "no mounted provider advertises a model; set provider and model in the plugin config",
    503
  );
}
function clipDiff(diff, maxChars) {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}
\u2026[diff truncated at ${maxChars} characters]`;
}
async function buildMessageContext(root, maxDiffChars, signal) {
  const [rawStatus, staged, worktree, subjects] = await Promise.all([
    git(statusArgs(), root, signal),
    git(["diff", "--cached", "--patch", "--no-color", "--no-ext-diff"], root, signal).catch(() => ""),
    git(["diff", "--patch", "--no-color", "--no-ext-diff"], root, signal).catch(() => ""),
    git(["log", "-n8", "--pretty=format:%s"], root).catch(() => "")
  ]);
  const status = parseStatus(rawStatus, root);
  const files = [
    ...status.staged.map((change) => `staged   ${change.status}  ${change.path}`),
    ...status.unstaged.map((change) => `unstaged ${change.status}  ${change.path}`),
    ...status.untracked.map((path) => `untracked ?  ${path}`)
  ];
  const stagedDiff = staged.trim();
  const diff = stagedDiff !== "" ? staged : worktree;
  const label = stagedDiff !== "" ? "Staged diff" : "Working tree diff (nothing staged)";
  const parts = [
    `Branch: ${status.branch ?? "(detached HEAD)"}`,
    "",
    "Changed files:",
    files.slice(0, MAX_FILES).join("\n") || "(none)"
  ];
  if (files.length > MAX_FILES) parts.push(`\u2026 and ${files.length - MAX_FILES} more`);
  const clipped = clipDiff(diff, maxDiffChars).trim();
  if (clipped !== "") parts.push("", `${label}:`, clipped);
  if (subjects.trim() !== "") parts.push("", "Recent commit subjects:", subjects.trim());
  return parts.join("\n");
}
function systemPrompt(language) {
  const languageRule = language === "" ? "Write in the language of the existing commit subjects; if there are none, write in English." : `Write in ${language}.`;
  return [
    "You write Git commit messages from a diff.",
    "Rules:",
    "- First line: imperative subject, at most 72 characters, no trailing period.",
    "- Then, only when the change needs explanation, a blank line and a body wrapped at 72 characters.",
    "- Say what the change does and why; never list the files.",
    '- Output only the message: no code fences, no quotes, no "Commit:" prefix.',
    languageRule
  ].join("\n");
}
function normalizeCommitMessage(raw) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[A-Za-z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:commit(?: message)?|message)\s*:\s*/i, "");
  if (text.length > 1 && /^["'`]/.test(text) && /["'`]$/.test(text)) text = text.slice(1, -1).trim();
  return text.replace(/\n{3,}/g, "\n\n");
}
async function generateCommitMessage(llm, settings, root, signal, override = {}) {
  const route = await resolveRoute(llm, settings, override);
  const context = await buildMessageContext(root, settings.maxDiffChars, signal);
  const parts = [];
  let failure = null;
  let finished = false;
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: systemPrompt(settings.language),
      messages: [{ role: "user", content: [{ type: "text", text: context }] }],
      temperature: 0,
      ...signal === void 0 ? {} : { signal }
    });
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
        parts.push(chunk.text);
      } else if (chunk?.type === "finish") {
        finished = true;
        const kind = String(chunk.reason?.kind ?? "error");
        if (kind !== "stop") {
          failure = {
            kind,
            code: typeof chunk.reason?.failure?.code === "string" ? chunk.reason.failure.code : void 0,
            message: typeof chunk.reason?.failure?.message === "string" ? chunk.reason.failure.message : void 0
          };
        }
      }
    }
  } catch (cause) {
    throw new CommitMessageError(cause instanceof Error ? cause.message : String(cause), 502);
  }
  if (!finished) throw new CommitMessageError("the model stream ended without a terminal finish", 502);
  if (failure !== null) {
    const detail = [failure.kind, failure.code].filter(Boolean).join(" ");
    throw new CommitMessageError(
      `the model call failed (${detail})${failure.message === void 0 ? "" : `: ${failure.message}`}`,
      502
    );
  }
  const message = normalizeCommitMessage(parts.join(""));
  if (message === "") throw new CommitMessageError("the model returned an empty message", 502);
  return { message, provider: route.provider, model: route.model };
}
export {
  CommitMessageError,
  buildMessageContext,
  clipDiff,
  generateCommitMessage,
  normalizeCommitMessage,
  normalizeSettings,
  resolveRoute,
  systemPrompt
};
//# sourceMappingURL=commit-message.js.map
