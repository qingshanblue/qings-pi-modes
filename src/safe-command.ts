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
  "sort", "uniq", "cut", "tr", "diff", "cmp", "jq", "nl", "basename",
  "dirname", "realpath", "readlink", "seq", "yes", "test", "true", "false",
  "printenv", "lscpu", "nproc", "lsblk", "md5sum", "sha1sum", "sha256sum",
  "sha512sum", "cksum", "od", "hexdump", "strings", "base64", "comm", "column",
]);
// DELIBERATELY ABSENT: `sed`. Its `e` script command (and GNU's `s///e`) executes
// shell commands, and a script is opaque to flag inspection - `sed '1e sh' file`
// would otherwise auto-run. Read-only sed usage now prompts; a policy rule can
// allow a specific pattern again (`"sed -n*": "allow"`).

/** git subcommands that do not write to the repo or the network. */
const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree",
  "describe", "blame", "shortlog", "whatchanged", "reflog", "grep", "cat-file",
  "rev-list", "diff-tree", "diff-index", "for-each-ref", "count-objects",
]);

/**
 * Flags that turn an otherwise read-only command into a writer/executor,
 * wherever they appear. These are `find`'s action flags plus the long forms of
 * the in-place/output options; the short forms are ambiguous between commands
 * (`grep -i`, `grep -o` are read-only) and are checked per command below.
 *
 * History: the original exact-match list (`^-exec$`, `^-delete$`, …) missed
 * `-execdir`, `-i.bak`, `--in-place=.bak`, `sort -o` and `uniq in out`, all of
 * which write or execute while the rest of the command looks read-only.
 */
const UNSAFE_ARG: readonly RegExp[] = [
  /^--?exec(dir)?(=.*)?$/, // find -exec / -execdir
  /^--?ok(dir)?$/, // find -ok / -okdir (the prompting variants still execute)
  /^--?delete$/, // find -delete
  /^--?(fprint|fprintf|fprint0|fls)(=.*)?$/, // find -fprint*/-fls (write files)
  /^--in-place(=.*)?$/, // sed/perl long form
  /^--output(=.*)?$/, // sort/tree/git long form
];

/**
 * Commands in SAFE whose SHORT output flag writes a file. Checked per command:
 * globally, `-o` would also match `grep -o` (read-only) and `-i` `grep -i`.
 * `-i` needs no such rule here - every command with in-place editing (sed,
 * perl, ruby, awk, ed) is absent from SAFE altogether.
 */
const SHORT_OUTPUT_FLAG = new Set(["sort", "tree"]);

function baseName(name: string): string {
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

/** True when ONE extracted command is a known read-only command with safe args. */
export function isSafeCommand(name: string, args: readonly string[]): boolean {
  if (!name) return false;
  const base = baseName(name);
  if (args.some((a) => UNSAFE_ARG.some((re) => re.test(a)))) return false;
  if (SHORT_OUTPUT_FLAG.has(base) && args.some((a) => /^--?o(=|$)/.test(a))) return false;
  // `uniq in.txt out.txt` writes the second positional argument.
  if (base === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return false;
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
