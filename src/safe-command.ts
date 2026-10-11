/**
 * A narrow, read-only bash allowlist — the fast path (Tier 1) in the Ask /
 * Edits / Auto approval flow.
 *
 * A command whose every extracted link is a known read-only command, and whose
 * raw text contains no redirect / command-substitution, runs without prompting
 * or classifier review. This is deliberately conservative: it never includes
 * anything that can write, execute arbitrary code, or fetch and run remote
 * content. When in doubt, omit it — the human/AI gate stays in place.
 *
 * Pure and SDK-free so the list and the edge behavior are unit-tested.
 */

/** Commands that only read (their default behavior writes nothing). */
const SAFE = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "tree", "find", "grep", "rg", "fd",
  "pwd", "echo", "printf", "which", "type", "whoami", "id", "groups",
  "uname", "hostname", "date", "uptime", "df", "du", "ps", "free", "top",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "sed", "jq", "nl", "basename",
  "dirname", "realpath", "readlink", "seq", "yes", "test", "true", "false",
  "printenv", "lscpu", "nproc", "lsblk", "md5sum", "sha1sum", "sha256sum",
  "sha512sum", "cksum", "od", "hexdump", "strings", "base64", "comm", "column",
]);

/** git subcommands that do not write to the repo or the network. */
const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree",
  "describe", "blame", "shortlog", "whatchanged", "reflog", "grep", "cat-file",
  "rev-list", "diff-tree", "diff-index", "for-each-ref", "count-objects",
]);

/** Flags that turn an otherwise read-only command into a writer/executor. */
const UNSAFE_FLAG = /^(-i|--in-place|-exec|-ok|--exec|-delete|-fprint|--fprint|-fls|--fls)$/;

function baseName(name: string): string {
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

/** True when ONE extracted command is a known read-only command with safe args. */
export function isSafeCommand(name: string, args: readonly string[]): boolean {
  if (!name) return false;
  const base = baseName(name);
  if (args.some((a) => UNSAFE_FLAG.test(a))) return false;
  if (base === "git") {
    const sub = args[0];
    return !!sub && GIT_READONLY.has(sub);
  }
  return SAFE.has(base);
}

/**
 * True when the WHOLE command line is safe to auto-allow: at least one command,
 * no shell redirect (`>`, `>>`, `>&`) and no command substitution (`$(…)` or
 * backticks) — either could write a file or run arbitrary code the parser does
 * not surface as a separate command — and every extracted command is safe.
 */
export function isSafeBashChain(
  commands: ReadonlyArray<{ name: string; args: readonly string[] }>,
  raw: string,
): boolean {
  if (commands.length === 0) return false;
  if (/[>\u0060]/.test(raw) || raw.includes("$(")) return false;
  return commands.every((c) => isSafeCommand(c.name, c.args));
}
