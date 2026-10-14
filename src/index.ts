/**
 * Permission Mode extension
 *
 * Switchable, data-driven permission modes (cycle with alt+m or /permission). A MODE
 * is a JSON bundle of an allow/ask/deny permission policy + UI metadata, defined
 * in `schema.ts` and shipped as data in `permission-mode.defaults.json`; users
 * override or extend it in `permission-mode.json`. The three orthogonal axes:
 *
 *   mode    (alt+m) - WHO approves an `ask`: plan → ask → edits → auto → accept.
 *   sandbox (alt+s) - the OS boundary (off / on / strict), only about out-of-project access.
 *   network (alt+n) - a domain allowlist, toggled filtered ⇄ open for the session.
 *
 * The five shipped modes:
 *   plan   - only Markdown may be created/edited; bash asks, read-only commands
 *            run sandboxed read-only. A system prompt steers the model to write a
 *            plan file and render it with show_plan.
 *   ask    - every mutating operation asks the human.
 *   edits  - in-project edit/write run without confirmation; bash still asks.
 *   auto   - `ask` decisions go to the AI safety classifier (classifier.ts)
 *            instead of the human; an ask that would run UNSANDBOXED always goes
 *            to the human instead.
 *   accept - never asks; still bounded by the sandbox state.
 *
 * The OS sandbox (@anthropic-ai/sandbox-runtime) is the real enforcement for
 * bash. If it's unavailable the sandboxed modes fall back to PROMPTING for
 * in-project bash and the TUI indicator shows a warning.
 *
 * This entry file is wiring only — flags, commands, shortcuts, the tool_call
 * dispatcher, the input/skill handler, and lifecycle. The logic lives in sibling
 * modules:
 *   schema.ts       mode definition types + plan prompt (defaults: permission-mode.defaults.json)
 *   resolve.ts      surface resolution engine (allow/ask/deny)
 *   bash-enforce.ts bash gate + exec plan (sandbox composition)
 *   bash-parse.ts   tree-sitter command extraction + heuristic fallback
 *   config-load.ts  layered permission-mode.json loader
 *   approvals.ts    session-scoped "Allow for session" store
 *   awareness.ts    sandbox-boundary system-prompt section (injected each turn)
 *   network.ts      live network session state (grants, denies, open toggle)
 *   paths.ts        out-of-project / protected-path predicates
 *   heuristics.ts   bash escape/privilege scan (tree-sitter fallback)
 *   sandbox.ts      SandboxController (runtime lifecycle, per-mode profile)
 *   status.ts       footer indicator
 *   show-plan.ts    show_plan tool   plan-render.ts  its renderer
 *
 * Install (see README.md):
 *   pi install git:github.com/qingshanblue/qings-pi-modes
 *   Linux also needs: bubblewrap, socat, ripgrep
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askWithSession, BlockedPaths, type ApprovalUI, type DenyOption, SessionApprovals } from "./approvals.ts";
import { sandboxAwarenessPrompt } from "./awareness.ts";
import { bashExecPlan, bashGate, isBenignOutsideRead } from "./bash-enforce.ts";
import { analyzeBash, escapeTargetFromReason, escapingPaths } from "./bash-parse.ts";
import { isSafeBashChain } from "./safe-command.ts";
import {
  auditStaleDefaults,
  defaultsChangedSince,
  describeStale,
  extensionVersion,
  hasGlobalConfig,
  loadDefaultsHistory,
  readAuditState,
  writeAuditState,
} from "./config-audit.ts";
import {
  SCHEMA_URL,
  globalConfigFile,
  hasMode,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistClassifierModel,
  persistModeDomains,
  persistModeRule,
  profileToConfig,
  readGlobalConfigRaw,
  stockDefaultsFile,
} from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { type NetAskResult, NetworkSession, isHostAllowed, normalizeDomain } from "./network.ts";
import { blockablePath, canonicalPath, displayPath, isOutside, isProtectedWrite, normalizeToolPath, resolvePlanPath, sandboxAllowedRoots } from "./paths.ts";
import {
  approvalMessage,
  DEFAULT_APPROVE_MODE,
  PLAN_ENTRY,
  type PendingPlan,
  type PlanEntry,
  planHash,
  restorePendingPlan,
  SAFE_PLAN_PATH,
  sessionBranch,
  showPlanSucceeded,
  shownPlanPath,
} from "./plan-approval.ts";
import { decide, decideBashChain, mostRestrictive } from "./resolve.ts";
import { SandboxController, commandFilesDir, networkFiltered, runtimeInstallDir, withDeniedReads } from "./sandbox.ts";
import { ensureScratchDir, scratchBase, scratchBaseOverridden, scratchDirName, sweepScratchDirs, withScratchDir } from "./scratch.ts";
import {
  type Action,
  type ModeDef,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  planModeSystemPrompt,
  type SandboxProfile,
  type SandboxState,
  type Surface,
} from "./schema.ts";
import { createShowPlanTool } from "./show-plan.ts";
import { updateStatus as renderStatus } from "./status.ts";
import {
  classifyAsk,
  createDenialState,
  normalizeClassifierConfig,
  recordDenial,
  recordSuccess,
  resolveClassifierModel,
  shouldFallbackToPrompting,
  subjectKey,
  VerdictCache,
  type ClassifierRegistry,
  type ClassifierSubject,
  type DenialState,
} from "./classifier.ts";

/** What the AI classifier needs to judge a pending `ask` (see autoDecide). */
interface AskReview {
  /** Tool name as the model should see it (e.g. `bash`, or `skill:<name>`). */
  tool: string;
  /** The tool input payload (the classifier bounds it before sending). */
  input: unknown;
  /** True when the target lies outside the project. */
  isOutside?: boolean;
  /**
   * Set on every prompt that would run the command OUTSIDE the sandbox (an
   * escape/privilege ask, or any ask in a mode whose sandbox is off). Such an
   * ask is never handed to the classifier — approving it is the strongest grant
   * in the system — so this forces the human prompt (a headless session denies).
   */
  escalateToHuman?: boolean;
}

/** Built-in file tools whose `input.path` is gated against the matching surface. */
const FILE_TOOL_SURFACE: Record<string, Surface> = {
  read: "read",
  edit: "edit",
  write: "write",
  ls: "ls",
  grep: "grep",
  find: "find",
};

/** Tools with a dedicated branch in the dispatcher (not gated via the `tool` surface). */
const BUILTIN_HANDLED = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "ls",
  "grep",
  "find",
  "web_search",
  "show_plan",
  "request_network_access", // prompts on its own — gating it would double-prompt
]);

export default async function (pi: ExtensionAPI) {
  // The engine starts on the shipped stock defaults (permission-mode.defaults.json);
  // session_start reloads the merged config (stock + global full-authority +
  // project tighten-only) from permission-mode.json.
  let config: PermissionModeConfig = loadStockDefaults();
  let modeName = config.defaultMode;
  // True when the current mode was auto-picked as the headless-child safety
  // fallback (no --perm flag, session entry, or forwarded env). The mode's
  // POLICY fully applies, but its systemPrompt is not injected — a planning
  // prompt steering a headless worker to write plan files and ask about alt+m
  // would misdirect it — and the fallback isn't exported to child processes
  // as if it were an explicit choice (children re-derive their own fallback).
  let fallbackMode = false;
  const root = process.cwd();

  const currentMode = (): ModeDef => (hasMode(config.modes, modeName) ? config.modes[modeName] : config.modes[config.defaultMode]);

  // This session's scratch directory (scratch.ts), created at session_start.
  // The EFFECTIVE sandbox profile — what the runtime is initialized with, what
  // the bounds are computed from, what /sandbox shows — is the mode's profile
  // with the scratch dir appended to allowWrite, so it is always writable and
  // never prompts, whatever the config says about the shared base.
  let scratchDir: string | undefined;
  // Paths the user blocked for the session ("Deny and block"): folded into the
  // effective profile's denyRead so the OS sandbox masks them for bash, and
  // checked directly for the (unsandboxed) file tools.
  const blocked = new BlockedPaths();
  // The sandbox is DECOUPLED from the mode: `alt+s` cycles this session state
  // (`off` / `on` / `strict`), and a mode may pin it (`sandboxPin`; no built-in
  // mode does). The shared profile (allowWrite / denyRead / network / …) lives
  // in `config.sandbox`; a mode's own legacy `sandbox` still overrides it.
  let sessionSandboxState: SandboxState = "on";
  /** A minimal safe profile when a config somehow lacks the top-level sandbox. */
  const FALLBACK_SANDBOX: SandboxProfile = {
    enabled: true,
    writable: true,
    allowWrite: ["."],
    denyWrite: [],
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    network: { allowedDomains: [], deniedDomains: [] },
  };
  /** The state that applies to `m`: its pin, else a legacy override, else the session state. */
  const effectiveSandboxState = (m: ModeDef): SandboxState => {
    if (m.sandboxPin) return m.sandboxPin;
    if (m.sandbox?.enabled === false) return "off";
    return sessionSandboxState;
  };
  /** The mode's sandbox profile with the effective state applied. */
  const modeSandbox = (m: ModeDef): SandboxProfile => {
    const base = config.sandbox ?? FALLBACK_SANDBOX;
    const merged = m.sandbox ? { ...base, ...m.sandbox } : base;
    const state = effectiveSandboxState(m);
    // The network boundary is an INDEPENDENT axis: the top-level `network`
    // block wins over any legacy profile value.
    const network = config.network ? { ...merged.network, ...config.network } : merged.network;
    const askOnBlockedHost = config.network?.askOnBlockedHost ?? merged.askOnBlockedHost;
    return { ...merged, enabled: state !== "off", writable: state !== "off", network, askOnBlockedHost };
  };
  // What the runtime is initialized with: the mode's profile plus the scratch
  // dir. The session's "Deny and block" paths are NOT part of it - they ride
  // along per command (sandbox.bashOps extraDenyRead), so a block never
  // restarts the runtime or its network proxy.
  const runtimeProfile = (m: ModeDef): SandboxProfile => withScratchDir(modeSandbox(m), scratchDir);
  // What bash effectively runs under, for the bounds, the awareness prompt, and /sandbox.
  const effectiveSandbox = (m: ModeDef): SandboxProfile => withDeniedReads(runtimeProfile(m), blocked.list());

  const sandbox = new SandboxController();
  // toolCallIds the user explicitly approved to run OUTSIDE the sandbox.
  const approvedUnsandboxed = new Set<string>();
  // "Allow for session" memory, keyed per-mode.
  const approvals = new SessionApprovals();
  // AI safety classifier state (used by modes with `classifier: true`, e.g.
  // automode): the consecutive-denial streak that falls back to the human
  // prompt, and a bounded cache so an identical retried action skips the model.
  let classifierDenials: DenialState = createDenialState();
  const classifierCache = new VerdictCache();

  /** Footer chip for the active mode when it uses the classifier. */
  const classifierChip = (ctx: ExtensionContext, m: ModeDef): string | undefined => {
    if (!m.classifier) return undefined;
    const cfg = normalizeClassifierConfig(config.classifier);
    if (!cfg.enabled) return "AI:off";
    return `AI:${cfg.model === "current" ? "inherit" : cfg.model}`;
  };

  /** Render the `perm` status chip, appending the classifier chip in AI modes. */
  const updateStatus = (
    ctx: ExtensionContext,
    m: ModeDef,
    sandboxState: Parameters<typeof renderStatus>[2],
    networkOpen: boolean,
  ): void =>
    renderStatus(
      ctx,
      { ...m, sandbox: effectiveSandbox(m) },
      sandboxState,
      networkOpen,
      classifierChip(ctx, m),
      (config.statusFormat ?? "compact") === "compact",
      effectiveSandboxState(m),
    );
  // One-step plan approval (plan-approval.ts): the plan show_plan rendered
  // last is offered for approval when the agent goes idle (A), confirmed on a
  // manual switch into the approve mode (B), and taken by /plan approve (C).
  // Persisted as perm-plan entries; restored on session_start/session_tree.
  let pendingPlan: PendingPlan | undefined;
  let planShownThisRun = false; // a show_plan succeeded during the current agent run
  let planPrompting = false; // one approval prompt at a time
  let approvingPlan = false; // setMode called by approvePlan must not ask B
  let approveModeWarned = false;
  const planCalls = new Map<string, string>(); // show_plan toolCallId -> requested path
  // Live network state: session domain grants/denies and the open toggle. The
  // sandbox-runtime proxy consults it (via net.decide) for every host outside
  // the allowlist, so changes apply instantly — no sandbox re-init.
  const net = new NetworkSession();
  // Latest UI-capable context, for prompts that fire OUTSIDE an event handler
  // (the network ask callback runs mid-bash, driven by the proxy).
  let uiCtx: ExtensionContext | undefined;

  /** ApprovalUI over pi's own terminal prompt; `askWithSession` applies the
   * session grants and the Allow once / session / forever / Deny vocabulary. */
  const approvalUI = (ctx: ExtensionContext): ApprovalUI => ({
    hasUI: ctx.hasUI,
    select: (t, o) => ctx.ui.select(t, o),
  });

  /** Prompt the user about a blocked host (the connection waits meanwhile). */
  const askNetHost = async (host: string, port: number | undefined): Promise<NetAskResult> => {
    const ctx = uiCtx;
    if (!ctx?.hasUI || effectiveSandbox(currentMode()).askOnBlockedHost === false) return "dismiss";
    const target = port !== undefined ? `${host}:${port}` : host;
    const choice = await ctx.ui.select(
      `Network: bash wants to reach ${target} (not in the allowlist) — allow?`,
      ["Allow for session", "Allow forever", "Deny"],
    );
    if (choice === "Allow for session") return "allow-session";
    if (choice === "Allow forever") {
      try {
        const file = persistModeDomains(getAgentDir(), modeName, [host]);
        config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"));
        ctx.ui.notify(`permission-mode: always allow ${host} in ${currentMode().label} — saved to ${file}`, "info");
      } catch (e) {
        ctx.ui.notify(`permission-mode: could not save domain: ${e}`, "error");
      }
      return "allow-forever";
    }
    if (choice === "Deny") return "deny";
    return "dismiss"; // dismissed prompt: deny this request, but don't remember
  };

  /**
   * Ask the AI classifier about a pending `ask`, falling back to the human
   * prompt per its policy. The classifier judges in-sandbox asks only: any ask
   * that would run the command OUTSIDE the sandbox (an escape, privilege
   * escalation, or a mode with the sandbox off) short-circuits to the human
   * below. `auto` means the AI is the gate — but only for what the sandbox still
   * bounds.
   */
  const autoDecide = async (
    ctx: ExtensionContext,
    surface: Surface,
    target: string | string[],
    title: string,
    onForever: (() => void | Promise<void>) | undefined,
    denyAnd: DenyOption | undefined,
    review: AskReview,
  ): Promise<boolean> => {
    const humanPrompt = (): Promise<boolean> =>
      askWithSession(
        approvalUI(ctx),
        approvals,
        modeName,
        surface,
        target,
        title,
        onForever,
        denyAnd,
      );
    const cfg = normalizeClassifierConfig(config.classifier);
    if (!cfg.enabled) return humanPrompt();
    // An escape (out-of-project path or privilege escalation) — and any ask that
    // would run the command OUTSIDE the sandbox — is never approved by the
    // classifier: that is the strongest grant in the system, and the reviewer
    // reads model-authored text. It always goes to the human; with no UI
    // (headless) askWithSession denies it outright.
    if (review.escalateToHuman) return humanPrompt();
    const targets = Array.isArray(target) ? target : [target];
    const subject: ClassifierSubject = {
      mode: modeName,
      surface,
      tool: review.tool,
      targets,
      input: review.input,
      cwd: ctx.cwd ?? root,
      isOutside: review.isOutside,
      inBounds: sandboxAllowedRoots(root, effectiveSandbox(currentMode())),
      recentUserRequest: recentUserRequests(ctx),
    };
    const key = subjectKey(subject, cfg.model);
    let verdict = classifierCache.get(key);
    try {
      if (!verdict) {
        verdict = await classifyAsk({
          registry: ctx.modelRegistry as unknown as ClassifierRegistry,
          model: resolveClassifierModel(ctx.modelRegistry, cfg.model, ctx.model),
          config: cfg,
          subject,
          signal: ctx.signal,
        });
        classifierCache.set(key, verdict);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (cfg.failClosed) {
        if (ctx.hasUI) ctx.ui.notify(`permission-mode: classifier unavailable — ${reason}; blocking ${surface}`, "warning");
        return false;
      }
      if (ctx.hasUI) ctx.ui.notify(`permission-mode: classifier unavailable — ${reason}; asking instead`, "warning");
      return humanPrompt();
    }
    if (verdict.allow) {
      classifierDenials = recordSuccess(classifierDenials, surface);
      return true;
    }
    classifierDenials = recordDenial(classifierDenials, surface);
    if (shouldFallbackToPrompting(classifierDenials, cfg.maxConsecutiveDenials, surface)) {
      if (ctx.hasUI) ctx.ui.notify("permission-mode: classifier denied repeatedly; asking you", "warning");
      return humanPrompt();
    }
    if (ctx.hasUI) ctx.ui.notify(`permission-mode: auto blocked ${surface} (${verdict.reason})`, "warning");
    return false;
  };

  /** Prompt to allow an `ask`, honoring session grants (a target list requires
   * every entry to be granted; granting remembers all). Returns true to allow.
   * When `onForever` is given, a fourth "Allow forever" option persists the rule.
   * In a classifier mode (`mode.classifier`), `review` routes the decision to
   * the AI instead of the human. */
  const promptAllow = async (
    ctx: ExtensionContext,
    surface: Surface,
    target: string | string[],
    title: string,
    onForever?: () => void | Promise<void>,
    denyAnd?: DenyOption,
    review?: AskReview,
  ): Promise<boolean> => {
    if (review && currentMode().classifier) {
      return autoDecide(ctx, surface, target, title, onForever, denyAnd, review);
    }
    return askWithSession(
      approvalUI(ctx),
      approvals,
      modeName,
      surface,
      target,
      title,
      onForever,
      denyAnd,
    );
  };

  /**
   * The "Deny and block … for this session" option for an escape prompt, or
   * undefined when none of the escaping paths may be blocked (see
   * blockablePath). Choosing it records the paths and re-applies the sandbox
   * profile so the runtime masks them at once.
   */
  const denyAndBlock = (ctx: ExtensionContext, targets: readonly string[]): DenyOption | undefined => {
    const m = currentMode();
    const eff = effectiveSandbox(m);
    const eligible = [
      ...new Set(
        targets
          .map((t) =>
            blockablePath(root, t, {
              alsoInside: eff.allowWrite ?? [],
              denyRead: eff.denyRead ?? [],
              allowRead: eff.allowRead ?? [],
              // What the sandbox itself needs to run: never maskable.
              protectedDirs: [path.dirname(process.execPath), runtimeInstallDir(), commandFilesDir()].filter((d): d is string => !!d),
            }),
          )
          .filter((t): t is string => t !== undefined && !blocked.covers(t)),
      ),
    ];
    if (eligible.length === 0) return undefined;
    const shown = eligible.map(displayPath).join(", ");
    return {
      label: `Deny and block ${shown} for this session`,
      run: async () => {
        for (const t of eligible) blocked.add(t);
        updateStatus(ctx, currentMode(), sandbox, net.open);
        ctx.ui.notify(
          `permission-mode: ${shown} ${eligible.length === 1 ? "is" : "are"} now unreadable inside the sandbox for this session (/perm blocks to list, /perm unblock <path> to lift)`,
          "info",
        );
      },
    };
  };

  /** "Allow forever": persist `<mode>.permission.<surface>.<key> = allow` to the
   * global config and hot-reload so it applies now and in future sessions. */
  const learnForever = (ctx: ExtensionContext, surface: Surface, key: string) => () => {
    try {
      const file = persistModeRule(getAgentDir(), modeName, surface, key, "allow");
      config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"));
      ctx.ui.notify(`permission-mode: always allow ${surface} "${key}" in ${currentMode().label} — saved to ${file}`, "info");
    } catch (e) {
      ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
    }
  };

  // Unsandboxed runs (unsandboxed modes, approved escapes, degraded) get TMPDIR pointed at
  // the scratch dir via the spawn hook; sandboxed runs get it from the runtime
  // (CLAUDE_CODE_TMPDIR, set at session_start). Windows tools read TEMP/TMP.
  const localBash = createBashTool(root, {
    spawnHook: (c) => {
      if (!scratchDir) return c;
      const env = { ...c.env, TMPDIR: scratchDir };
      if (process.platform === "win32") Object.assign(env, { TEMP: scratchDir, TMP: scratchDir });
      return { ...c, env };
    },
  });

  pi.registerFlag("perm", {
    description: `Start in permission mode: ${config.cycleOrder.join(" | ")}`,
    type: "string",
    default: "",
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for the sandboxed modes (heuristics + prompts only)",
    type: "boolean",
    default: false,
  });

  // Hide a mode's `hideTools` from the model (pre-exposure), restoring the rest.
  //
  // The base is pi's CURRENT active set, not every registered tool: the user's
  // own tool selection (`defaultTools` in settings, --exclude-tools) must stay
  // in force — the old "all tools minus hideTools" base silently re-enabled
  // grep/find/ls/powershell for everyone (#2). We remember what WE hid (a
  // subset of what was active at the time) so a mode switch restores exactly
  // that and nothing else, and we only call setActiveTools when the set
  // actually changes (this runs every turn).
  //
  // `hideTools` is honored literally — including our own `show_plan`, which
  // used to be exempt: a setup that never plans has no use for it, and a
  // config entry that is silently ignored is worse than one that works. The
  // loader warns when a mode with the Plan prompt hides it (see config-load).
  let hiddenByUs = new Set<string>();
  const applyToolVisibility = () => {
    const hide = new Set(currentMode().hideTools ?? []);
    const current = pi.getActiveTools();
    const base = [...new Set([...current, ...hiddenByUs])]; // active as it would be without our hiding
    const next = base.filter((n) => !hide.has(n));
    hiddenByUs = new Set(base.filter((n) => hide.has(n)));
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) pi.setActiveTools(next);
  };

  const setMode = async (name: string, ctx: ExtensionContext, persist = true, viaFallback = false) => {
    if (!hasMode(config.modes, name)) return;
    uiCtx = ctx;
    const previous = modeName;
    modeName = name;
    fallbackMode = viaFallback;
    classifierDenials = createDenialState(); // a fresh mode starts with a clean streak
    classifierCache.clear();
    // Forward to child pi processes (e.g. subagents) via inherited env. The child
    // adopts it on session_start unless an explicit --perm flag overrides. The
    // implicit headless fallback is NOT forwarded: a child with no explicit mode
    // derives the same safe fallback itself (and skips the systemPrompt too).
    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    await sandbox.applyProfile(runtimeProfile(m)); // re-init runtime if the profile changed
    applyToolVisibility();
    updateStatus(ctx, m, sandbox, net.open);
    if (persist) pi.appendEntry<PermState>("perm-mode", { mode: modeName });
    // B: a manual switch into the approve mode while a plan is pending (alt+m,
    // /perm <mode>). Not on session_start/resume (persist=false) and not for
    // the switch approvePlan itself performs.
    if (persist && pendingPlan && !approvingPlan && ctx.hasUI && name !== previous && name === approveModeName()) {
      const plan = pendingPlan;
      const yes = await ctx.ui.confirm(
        `Implement ${plan.path} now?`,
        `Yes sends the approval message to the model. No leaves you in ${m.label} with nothing sent (/plan approve later).`,
      );
      if (yes) await approvePlan(ctx);
    }
  };

  const approveModeName = (): string => config.plan?.approveMode ?? DEFAULT_APPROVE_MODE;

  /** The approve mode's definition, or undefined (with a one-time warning) when the config names a mode that does not exist. */
  const approveModeDef = (ctx: ExtensionContext): ModeDef | undefined => {
    const target = approveModeName();
    if (hasMode(config.modes, target)) return config.modes[target];
    if (!approveModeWarned) {
      approveModeWarned = true;
      ctx.ui.notify(`permission-mode: plan.approveMode "${target}" is not a defined mode; plan approval is off until it is fixed`, "warning");
    }
    return undefined;
  };

  /**
   * Approve the pending plan: switch to the approve mode when not already
   * there, forget the plan (also in the session), and send the approval as a
   * real user message so a new turn starts under that mode's system prompt.
   */
  const approvePlan = async (ctx: ExtensionContext): Promise<boolean> => {
    const plan = pendingPlan;
    if (!plan || !approveModeDef(ctx)) return false;
    // Approval covers what the user saw: a plan file edited after show_plan
    // rendered it (by the model in the same run, say) is not approved blindly.
    if (plan.sha && planHash(root, plan.path) !== plan.sha) {
      ctx.ui.notify(`permission-mode: ${plan.path} changed since it was shown; ask for show_plan again before approving`, "warning");
      return false;
    }
    const target = approveModeName();
    approvingPlan = true;
    try {
      if (modeName !== target) await setMode(target, ctx);
    } finally {
      approvingPlan = false;
    }
    pendingPlan = undefined;
    pi.appendEntry<PlanEntry>(PLAN_ENTRY, {});
    // agent_end fires while the run still counts as streaming (it settles
    // after its listeners), and a plain send throws then. A follow-up is
    // queued behind the finishing run and pi starts a fresh run for it; when
    // the agent is idle (B via alt+m, /plan approve) it is sent right away.
    pi.sendUserMessage(approvalMessage(config.plan?.approveMessage, plan.path), { deliverAs: "followUp" });
    return true;
  };

  /** A: offer the plan shown during the run that just ended. Decline keeps it pending for B and C. */
  const offerPlanApproval = async (ctx: ExtensionContext): Promise<void> => {
    const plan = pendingPlan;
    if (!plan || plan.declined || planPrompting || !ctx.hasUI) return;
    const target = approveModeDef(ctx);
    if (!target) return;
    planPrompting = true;
    try {
      const accept = `Accept: switch to ${target.label} and implement it`;
      const decline = `Decline: keep refining in ${currentMode().label}`;
      const choice = await ctx.ui.select(`Plan ready: ${plan.path}`, [accept, decline]);
      if (choice === accept) await approvePlan(ctx);
      else plan.declined = true;
    } finally {
      planPrompting = false;
    }
  };

  /**
   * The mode for a headless child without a forwarded mode: its defaultMode.
   * The OS sandbox state independently defaults to `on` for children (and is
   * forwarded explicitly otherwise), so even a permissive default is confined.
   */
  const safeChildMode = (): string => config.defaultMode;

  const cycle = async (ctx: ExtensionContext) => {
    const order = config.cycleOrder;
    const idx = order.indexOf(modeName);
    await setMode(order[(idx + 1) % order.length], ctx);
  };

  /**
   * Resolve which mode to start in:
   *   1. explicit --perm flag, then 2. persisted session entry (resume),
   *   3. PI_PERMISSION_MODE env (forwarded from a parent / user-set),
   *   4. headless child with none of the above → its defaultMode, flagged as
   *      `fallback` (its policy applies, but its systemPrompt is not injected),
   *   5. otherwise the current/default mode.
   */
  const pickMode = (ctx: ExtensionContext, useFlag: boolean): { name: string; fallback: boolean } => {
    let resolved: string | undefined;
    if (useFlag) {
      const flag = String(pi.getFlag("perm") ?? "").toLowerCase();
      if (hasMode(config.modes, flag)) resolved = flag;
    }
    if (!resolved) {
      // An explicit --perm flag wins over the persisted entry (resume with a flag).
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "perm-mode") {
          const data = entry.data as PermState | undefined;
          if (hasMode(config.modes, data?.mode)) resolved = data.mode;
        }
      }
    }
    if (!resolved) {
      const env = process.env.PI_PERMISSION_MODE;
      if (hasMode(config.modes, env)) resolved = env;
    }
    if (!resolved && !ctx.hasUI) return { name: safeChildMode(), fallback: true }; // headless child, no forwarded mode
    return { name: resolved ?? modeName, fallback: false };
  };

  pi.registerShortcut("alt+m", {
    description: `Cycle permission mode (${config.cycleOrder.join(" -> ")})`,
    handler: async (ctx) => cycle(ctx),
  });
  pi.registerCommand("permission", {
    description: `Set the permission mode: /permission [<mode>|init|clear-approvals|blocks|unblock <path>] — no args opens a picker`,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "") {
        if (!ctx.hasUI) return ctx.ui.notify(`permission-mode: usage: /permission [${config.cycleOrder.join("|")}|init|clear-approvals|blocks|unblock <path>]`, "warning");
        const options = config.cycleOrder.map((name) => `${name === modeName ? "✓" : " "} ${config.modes[name]?.label ?? name}`);
        const picked = await ctx.ui.select("Permission mode (alt+m cycles)", options);
        const idx = picked ? options.indexOf(picked) : -1;
        if (idx >= 0) await setMode(config.cycleOrder[idx], ctx);
        return;
      }
      if (arg === "clear-approvals") {
        approvals.clearAll();
        const hadBlocks = blocked.list().length > 0;
        blocked.clear();
        return ctx.ui.notify(`permission-mode: cleared session approvals${hadBlocks ? " and blocked paths" : ""}`, "info");
      }
      if (arg === "blocks") {
        const list = blocked.list();
        return ctx.ui.notify(
          list.length ? `permission-mode: blocked for this session:\n${list.map((b) => `  - ${displayPath(b)}`).join("\n")}` : "permission-mode: no paths blocked for this session",
          "info",
        );
      }
      if (arg === "unblock" || arg.startsWith("unblock ")) {
        const raw = args.trim().slice("unblock".length).trim();
        if (!raw) return ctx.ui.notify("permission-mode: usage: /permission unblock <path>", "warning");
        const target = canonicalPath(root, normalizeToolPath(raw));
        if (!blocked.remove(target)) return ctx.ui.notify(`permission-mode: ${displayPath(target)} is not blocked (see /permission blocks)`, "warning");
        return ctx.ui.notify(`permission-mode: ${displayPath(target)} is readable again for this session`, "info");
      }
      if (arg === "init") {
        // Scaffold an editable FULL copy of the stock defaults at the global
        // path, stamped with its provenance: every value in it overrides the
        // shipped default, and the audit (config-audit.ts) warns when one of
        // them falls behind a later version's default.
        const dest = globalConfigFile(getAgentDir());
        if (existsSync(dest)) {
          return ctx.ui.notify(`permission-mode: ${dest} already exists - edit it directly`, "warning");
        }
        try {
          const stock = JSON.parse(readFileSync(stockDefaultsFile(), "utf-8")) as Record<string, unknown>;
          const { $schema: _stockSchema, ...rest } = stock;
          const copy = {
            $schema: SCHEMA_URL, // the stock file's relative path would not resolve from the agent dir
            $comment:
              `Copied from the pi-permission-modes ${extensionVersion()} stock defaults by /permission init. ` +
              "Every value here overrides the shipped default; delete what you don't intend to change so " +
              "future default updates reach you. The extension warns at session start when a value here " +
              "still matches an outdated default; set \"acknowledgeDefaults\" to the version you reviewed " +
              "against to silence that until the defaults change again.",
            ...rest,
          };
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, `${JSON.stringify(copy, null, 2)}\n`);
          return ctx.ui.notify(`permission-mode: wrote ${dest} - edit it to customize your modes`, "info");
        } catch (e) {
          return ctx.ui.notify(`permission-mode: could not write ${dest}: ${e}`, "error");
        }
      }
      if (hasMode(config.modes, arg)) await setMode(arg, ctx);
      else ctx.ui.notify(`permission-mode: unknown mode or subcommand "${arg}"; usage: /permission [${config.cycleOrder.join("|")}|init|clear-approvals|blocks|unblock <path>]`, "warning");
    },
  });
  /** Persist a classifier model ref and refresh the live session state. */
  const runClassifierModelChange = async (value: string, ctx: ExtensionContext): Promise<void> => {
    const file = persistClassifierModel(getAgentDir(), value);
    config = loadModeConfig(ctx.cwd, getAgentDir(), (msg) => ctx.ui.notify(msg, "warning"));
    classifierCache.clear(); // verdicts from the previous model must not survive
    classifierDenials = createDenialState();
    updateStatus(ctx, currentMode(), sandbox, net.open);
    const activeRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
    ctx.ui.notify(
      `permission-mode: classifier model → ${value === "current" ? `current (${activeRef})` : value} — saved to ${file}`,
      "info",
    );
  };

  pi.registerCommand("classifier-model", {
    description: "Show or switch the automode classifier model (interactive picker; current = follow the active session model)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const cfg = normalizeClassifierConfig(config.classifier);
      const activeRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      // No argument: an interactive picker, like /model — `current-model` first
      // (follows the session model), then every model the registry can authenticate.
      if (!arg) {
        if (!ctx.hasUI) {
          return ctx.ui.notify(
            `permission-mode: classifier model: ${cfg.model === "current" ? `current (${activeRef ?? "none"})` : cfg.model} — usage: /classifier-model current | <provider/model>`,
            "info",
          );
        }
        const refs: Array<{ value: string; label: string }> = [{ value: "current", label: "current-model" }];
        for (const model of ctx.modelRegistry.getAvailable()) {
          refs.push({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` });
        }
        const active = cfg.model;
        const picked = await ctx.ui.select(
          "Classifier model (auto mode)",
          refs.map((r) => (r.value === active ? `\u2713 ${r.label}` : r.label)),
        );
        if (!picked) return;
        const value = picked.replace(/^\u2713\s*/, "");
        return runClassifierModelChange(value === "current-model" ? "current" : value, ctx);
      }

      if (arg !== "current" && !/^[^/\s]+\/\S+$/.test(arg)) {
        return ctx.ui.notify(`permission-mode: "${arg}" is not "current" or a provider/model id`, "warning");
      }
      try {
        await runClassifierModelChange(arg, ctx);
      } catch (e) {
        ctx.ui.notify(`permission-mode: could not save classifier model: ${e}`, "error");
      }
    },
  });
  const networkEnforcing = () => sandbox.ready && networkFiltered(effectiveSandbox(currentMode()));

  const toggleNetwork = async (ctx: ExtensionContext) => {
    uiCtx = ctx;
    if (!networkEnforcing()) {
      return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
    }
    net.open = !net.open;
    updateStatus(ctx, currentMode(), sandbox, net.open);
  };

  pi.registerShortcut("alt+n", {
    description: "Toggle network filtering for this session (filtered <-> open)",
    handler: toggleNetwork,
  });

  pi.registerCommand("plan", {
    description: "Plan approval: /plan approve (switch to the approve mode and implement the pending plan) | /plan status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "approve") {
        if (!pendingPlan) return ctx.ui.notify("permission-mode: no plan pending (show_plan has not rendered one in this session)", "warning");
        await approvePlan(ctx);
        return;
      }
      if (arg === "" || arg === "status") {
        return ctx.ui.notify(
          pendingPlan ? `permission-mode: pending plan: ${pendingPlan.path} (/plan approve to implement it)` : "permission-mode: no plan pending",
          "info",
        );
      }
      ctx.ui.notify("permission-mode: usage: /plan approve | status", "warning");
    },
  });

  pi.registerCommand("network", {
    description: "Network filtering: /network [status|allow <domain…>|open|restrict|reset] — no args opens a picker",
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const m = currentMode();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      if (sub === "") {
        // Interactive toggle: pick the filtering posture for this session.
        if (!networkEnforcing()) return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
        const options = [
          `${!net.open ? "✓" : " "} Limit to the allowlist (net:limit)`,
          `${net.open ? "✓" : " "} Free — no filtering this session (net:free)`,
        ];
        const picked = await ctx.ui.select("Network filtering (alt+n toggles)", options);
        if (picked) {
          const wantOpen = picked.includes("net:free");
          if (wantOpen !== net.open) toggleNetwork(ctx);
        }
        return;
      }
      if (sub === "open") {
        if (!net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network is already open for this session", "info");
      }
      if (sub === "restrict") {
        if (net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network filtering is already active", "info");
      }
      if (sub === "reset") {
        net.clear();
        updateStatus(ctx, m, sandbox, net.open);
        return ctx.ui.notify("permission-mode: cleared session network grants/denies; filtering restored", "info");
      }
      if (sub === "allow") {
        const domains = [...new Set(parts.slice(1).map(normalizeDomain).filter((d): d is string => d !== undefined))];
        const safe = domains.filter((d) => !isUnsafeDomain(d));
        if (safe.length === 0) {
          return ctx.ui.notify("permission-mode: usage: /network allow <domain> [domain…] — concrete hosts or *.sub wildcards", "warning");
        }
        net.grant(safe);
        const dropped = domains.length - safe.length;
        return ctx.ui.notify(
          `permission-mode: allowed for this session: ${safe.join(", ")}${dropped ? ` (${dropped} overly-broad pattern(s) rejected)` : ""}`,
          "info",
        );
      }
      // status
      const state = !networkEnforcing()
        ? "OPEN — nothing filters in this mode/state"
        : net.open
          ? "OPEN for this session (/network restrict or alt+n to re-enable filtering)"
          : "filtered (alt+n or /network open to disable)";
      return ctx.ui.notify(
        [
          `Network (${m.label}): ${state}`,
          `Mode allowlist: ${modeSandbox(m).network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          `Session denies: ${net.denies().join(", ") || "(none)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  /** Set the session sandbox state (alt+s / /sandbox off|on|strict). */
  const setSandboxState = async (state: SandboxState, ctx: ExtensionContext, persist = true): Promise<void> => {
    uiCtx = ctx;
    sessionSandboxState = state;
    process.env.PI_PERMISSION_SANDBOX = state;
    const m = currentMode();
    await sandbox.applyProfile(runtimeProfile(m)); // no-op when the effective profile is unchanged (a pinned mode)
    updateStatus(ctx, m, sandbox, net.open);
    if (persist) pi.appendEntry("perm-sandbox", { state });
  };
  const cycleSandbox = async (ctx: ExtensionContext): Promise<void> => {
    const order: SandboxState[] = ["off", "on", "strict"];
    await setSandboxState(order[(order.indexOf(sessionSandboxState) + 1) % order.length], ctx);
  };

  /**
   * The user's recent messages (latest first, `max` kept) — the classifier's
   * authorization context. Without them the reviewer only sees the raw action
   * and over-denies legitimate work (it cannot tell an intended edit from a
   * rogue one). Multi-turn work especially: the request that motivated an edit
   * is often several turns back.
   */
  const recentUserRequests = (ctx: ExtensionContext, max = 3): string | undefined => {
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
    const found: string[] = [];
    for (let i = entries.length - 1; i >= 0 && found.length < max; i--) {
      const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (e?.type !== "message" || e.message?.role !== "user") continue;
      const content = e.message.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && "text" in block) text += String((block as { text?: unknown }).text ?? "");
        }
      }
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (cleaned) found.unshift(cleaned.length > 300 ? `${cleaned.slice(0, 300)}\u2026` : cleaned);
    }
    return found.length ? found.join("\n\u2014\n") : undefined;
  };

  pi.registerCommand("sandbox", {
    description: "Show or set the sandbox state: /sandbox [off|on|strict|status] — no args opens a picker",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "off" || arg === "on" || arg === "strict") return setSandboxState(arg, ctx);
      if (arg && arg !== "status") return ctx.ui.notify(`permission-mode: usage: /sandbox [off|on|strict|status] (got "${arg}")`, "warning");
      if (arg === "" && ctx.hasUI) {
        // Interactive picker: pick the boundary for this session.
        const hints: Record<SandboxState, string> = {
          off: "off — no OS boundary (bash unsandboxed)",
          on: "on — outside writes blocked (reads allowed)",
          strict: "strict — outside read + write blocked",
        };
        const order: SandboxState[] = ["off", "on", "strict"];
        const state = effectiveSandboxState(currentMode());
        const options = order.map((s) => `${s === state ? "✓" : " "} ${hints[s]}`);
        const picked = await ctx.ui.select("Sandbox boundary (alt+s cycles)", options);
        const idx = picked ? order.findIndex((s) => picked.startsWith(`✓ ${hints[s]}`) || picked.startsWith(`  ${hints[s]}`)) : -1;
        if (idx >= 0) await setSandboxState(order[idx], ctx);
        return;
      }
      const m = currentMode();
      const sb = modeSandbox(m);
      if (m.sandboxPin) ctx.ui.notify(`permission-mode: ${m.label} pins the sandbox to "${m.sandboxPin}"`, "info");
      if (!sb.enabled) {
        return ctx.ui.notify(`${m.label}: sandbox OFF (state ${effectiveSandboxState(m)}) — bash runs unsandboxed`, "info");
      }
      if (sandbox.disabled) return ctx.ui.notify("Sandbox disabled via --no-sandbox", "info");
      if (!sandbox.ready) return ctx.ui.notify(`Sandbox unavailable: ${sandbox.warn ?? "unknown"}`, "warning");
      const c = profileToConfig(effectiveSandbox(m));
      ctx.ui.notify(
        [
          `Sandbox: ACTIVE for ${m.label} (state: ${effectiveSandboxState(m)})`,
          "",
          `Scratch dir: ${scratchDir ?? "(none)"}`,
          `Network: ${net.open ? "OPEN for this session (alt+n)" : "filtered (alt+n)"}`,
          `Network allowed: ${c.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          `Deny read:  ${c.filesystem?.denyRead?.join(", ") || "(none)"}`,
          ...(c.filesystem.allowRead?.length ? [`Allow read: ${c.filesystem.allowRead.join(", ")} (inside the denied paths)`] : []),
          `Session blocks: ${blocked.list().map(displayPath).join(", ") || "(none)"}`,
          `Allow write: ${c.filesystem?.allowWrite?.join(", ") || "(none)"}`,
          `Deny write:  ${c.filesystem?.denyWrite?.join(", ") || "(none)"}`,
          ...(sandbox.extras?.allowWrite.length ? [`Git dirs (worktree/submodule): writable ${sandbox.extras.allowWrite.join(", ")}; hooks and config denied`] : []),
          ...(sandbox.dependencyWarnings.length > 0 ? ["", `Runtime warnings: ${sandbox.dependencyWarnings.join("; ")}`] : []),
        ].join("\n"),
        "info",
      );
    },
  });
  pi.registerShortcut("alt+s", {
    description: "Cycle sandbox state (off → on → strict)",
    handler: cycleSandbox,
  });

  // Replace built-in bash so the sandbox can wrap it. Sandboxing is recomputed at
  // run time from the active mode's profile: disabled (`sandbox.enabled:false`),
  // and the degraded fallback run unsandboxed; non-writable modes run read-only.
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, _ctx) {
      const approved = approvedUnsandboxed.delete(id); // user granted an escape
      const m = currentMode();
      const sb = modeSandbox(m);
      const plan = bashExecPlan(sb.enabled, true, sandbox.ready, approved); // boundary-only: the sandbox never makes bash read-only
      if (sb.enabled && !approved && !plan.sandboxed) {
        // The gate allowed this call because the sandbox was ready; it isn't
        // any more (a failed profile switch, a re-init in flight). Never
        // degrade silently to an unsandboxed run: fail the call instead.
        throw new Error("permission-mode: the sandbox became unavailable after this command was approved; run it again");
      }
      const ops = plan.sandboxed
        ? sandbox.bashOps({ readOnly: plan.readOnly, keepWritable: scratchDir ? [scratchDir] : [], extraDenyRead: blocked.list(), tmpdir: scratchDir })
        : null;
      if (!ops) return localBash.execute(id, params, signal, onUpdate);
      const sandboxed = createBashTool(root, { operations: ops });
      return sandboxed.execute(id, params, signal, onUpdate);
    },
  });

  // Plan Mode helper: render a written plan file to the user (display-only).
  pi.registerTool(await createShowPlanTool(root));

  // Model-initiated network grants: ask the user to allow domains outside the
  // sandbox allowlist (batch-capable, so one prompt covers an install that
  // needs several hosts). Grants land in the session state the ask callback
  // reads — no sandbox re-init. Available in every mode; when nothing filters
  // (unsandboxed modes, degraded, /net open) it says so instead of prompting.
  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    promptSnippet: "Ask the user to allow bash network access to domains outside the sandbox allowlist",
    description:
      "Ask the user to allow bash network access to one or more domains outside the sandbox allowlist. " +
      "Use it when a blocked host stops you (downloads, installs, API troubleshooting), or to get every needed " +
      "domain approved up front before a command that hits several hosts. Accepts exact hosts (api.example.com) " +
      "and subdomain wildcards (*.example.com).",
    parameters: Type.Object({
      domains: Type.Array(Type.String({ description: "Domain or subdomain wildcard, e.g. api.example.com or *.example.com" }), {
        description: "The domains to request access to",
      }),
      reason: Type.String({ description: "One short line: why access is needed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      const { domains = [], reason = "" } = params as { domains?: string[]; reason?: string };
      const m = currentMode();
      if (!sandbox.ready || !networkFiltered(modeSandbox(m)) || net.open) {
        return text("Network is not filtered right now - no grant needed, just run the command.");
      }
      const normalized = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== undefined))];
      const rejected = normalized.filter(isUnsafeDomain);
      const modeList = modeSandbox(m).network?.allowedDomains ?? [];
      const covered = (d: string) =>
        modeList.includes(d) || net.grants().includes(d) || (!d.startsWith("*.") && (isHostAllowed(d, modeList) || net.isGranted(d)));
      const need = normalized.filter((d) => !isUnsafeDomain(d) && !covered(d));
      const rejectedNote = rejected.length ? ` Rejected as overly broad: ${rejected.join(", ")}.` : "";
      if (need.length === 0) {
        return text(
          rejected.length && normalized.length === rejected.length
            ? `No grantable domains.${rejectedNote} Use a concrete host or a *.sub wildcard.`
            : `Already allowed — just run the command.${rejectedNote}`,
        );
      }
      const pctx = ctx ?? uiCtx;
      if (!pctx?.hasUI) return text("Denied: no interactive user available to approve network access.");
      const choice = await pctx.ui.select(
        `Model requests network access to ${need.join(", ")} — ${reason.trim() || "no reason given"}. Allow?`,
        ["Allow for session", "Allow forever", "Deny"],
      );
      if (choice !== "Allow for session" && choice !== "Allow forever") {
        return text(
          `Denied by the user: ${need.join(", ")}. Don't retry these hosts — work within the allowlist or ask the user how to proceed.${rejectedNote}`,
        );
      }
      net.grant(need);
      let saved = "";
      if (choice === "Allow forever") {
        try {
          const file = persistModeDomains(getAgentDir(), modeName, need);
          config = loadModeConfig(pctx.cwd, getAgentDir(), (msg) => pctx.ui.notify(msg, "warning"));
          saved = ` (saved permanently for ${currentMode().label})`;
          pctx.ui.notify(`permission-mode: always allow ${need.join(", ")} in ${currentMode().label} — saved to ${file}`, "info");
        } catch (e) {
          pctx.ui.notify(`permission-mode: could not save domains: ${e}`, "error");
        }
      }
      return text(`Granted${saved}: ${need.join(", ")}. Retry the blocked command now.${rejectedNote}`);
    },
  });

  /**
   * Defaults audit (config-audit.ts): warn about global-config values that
   * still hold an outdated default, and - once per version change - tell
   * users with a global config which defaults changed. Never throws.
   */
  const auditGlobalConfig = (ctx: ExtensionContext) => {
    const agentDir = getAgentDir();
    const warn = (m: string) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m));
    const current = { version: extensionVersion(), defaults: loadStockDefaults() };
    const history = loadDefaultsHistory();
    const state = readAuditState(agentDir);
    try {
      if (hasGlobalConfig(agentDir)) {
        const raw = readGlobalConfigRaw(agentDir);
        if (raw) {
          const ack = typeof raw.acknowledgeDefaults === "string" ? raw.acknowledgeDefaults : undefined;
          const stale = auditStaleDefaults(raw, current, history, ack);
          if (stale.length > 0) {
            warn(
              [
                `permission-mode: ${stale.length} value(s) in ${globalConfigFile(agentDir)} still hold an outdated default:`,
                ...stale.map((f) => `  - ${describeStale(f)}`),
                `Update them, or set "acknowledgeDefaults": "${current.version}" to keep them knowingly.`,
              ].join("\n"),
            );
          }
        }
        if (state.lastVersion && state.lastVersion !== current.version) {
          const changed = defaultsChangedSince(state.lastVersion, current, history);
          if (changed.length > 0) {
            warn(
              `permission-mode: updated ${state.lastVersion} -> ${current.version}; the stock defaults changed for ` +
                `${changed.join(", ")}. Compare your global config with ${stockDefaultsFile()} so you don't miss ` +
                "security or behavior improvements.",
            );
          }
        }
      }
    } finally {
      if (state.lastVersion !== current.version) writeAuditState(agentDir, { lastVersion: current.version });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    const warn = (m: string) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m));
    try {
      config = loadModeConfig(ctx.cwd, getAgentDir(), warn);
    } catch (e) {
      // The loader guards its inputs; this is the last line of defense so a
      // config problem can never skip the sandbox init below.
      warn(`permission-mode: could not load configuration, keeping the previous one: ${e instanceof Error ? e.message : String(e)}`);
    }
    auditGlobalConfig(ctx);
    if (!hasMode(config.modes, modeName)) modeName = config.defaultMode;
    // Resolve the start mode BEFORE init so the sandbox initializes with the
    // right profile, then setMode reconciles status (applyProfile is a no-op).
    const picked = pickMode(ctx, true);
    modeName = picked.name;
    pendingPlan = restorePendingPlan(sessionBranch(ctx));
    planShownThisRun = false;
    planCalls.clear();
    // Per-session scratch directory, created up front so the sandbox profile,
    // the bounds, and the awareness prompt all agree on it. Keyed on the
    // session id (a resumed session finds its files); stale siblings swept.
    const base = scratchBase();
    const dir = path.join(base, scratchDirName(ctx.sessionManager.getSessionId?.()));
    if (ensureScratchDir(dir, { sharedBase: !scratchBaseOverridden() })) {
      scratchDir = dir;
      // The runtime points TMPDIR here inside sandboxed commands (it reads the
      // newer name first, the older one is kept for its 0.0.26-era behavior).
      process.env.CLAUDE_CODE_TMPDIR = dir;
      process.env.CLAUDE_TMPDIR = dir;
      sweepScratchDirs(base, dir);
    } else {
      scratchDir = undefined;
      delete process.env.CLAUDE_CODE_TMPDIR;
      delete process.env.CLAUDE_TMPDIR;
      if (ctx.hasUI) ctx.ui.notify(`permission-mode: could not create the scratch directory ${dir}`, "warning");
    }
    // Restore the sandbox state: forwarded env > persisted entry > the "on"
    // default. It is exported so child pi processes inherit the same state.
    {
      const valid = (v: unknown): v is SandboxState => v === "off" || v === "on" || v === "strict";
      const envSb = process.env.PI_PERMISSION_SANDBOX;
      if (valid(envSb)) sessionSandboxState = envSb;
      else
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "custom" || entry.customType !== "perm-sandbox") continue;
          const st = (entry.data as { state?: unknown } | undefined)?.state;
          if (valid(st)) sessionSandboxState = st;
        }
      process.env.PI_PERMISSION_SANDBOX = sessionSandboxState;
    }
    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => ctx.ui.notify(m, "warning"),
      profile: runtimeProfile(currentMode()),
      // Live network gate: the proxy consults session state for every host
      // outside the allowlist; unknown hosts prompt via askNetHost.
      askHost: (host, port) => net.decide(host, port, askNetHost),
    });
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    pendingPlan = restorePendingPlan(sessionBranch(ctx)); // the branch's own plan state
    planShownThisRun = false;
    planCalls.clear();
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_shutdown", async () => {
    approvals.clearAll(); // session-scoped grants don't outlive the session
    blocked.clear(); // nor do "Deny and block" paths
    net.clear(); // network grants/denies and the open toggle are session-scoped too
    pendingPlan = undefined; // restored from the session entries on the next start
    planCalls.clear();
    await sandbox.reset();
  });

  // Plan approval (A): a show_plan that succeeded during this run is offered
  // once the agent is idle, so the plan is on screen and the accepting turn
  // starts under the approve mode's prompt, never under a Plan prompt still
  // in effect. Nothing is asked after the implementing run (no show_plan then).
  pi.on("agent_start", async () => {
    planShownThisRun = false;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!planShownThisRun) return;
    planShownThisRun = false;
    await offerPlanApproval(ctx);
  });

  // Drop any unconsumed escape grant once the tool call resolves; record a
  // rendered plan as pending (persisted, so resume and /reload keep it).
  pi.on("tool_execution_end", async (event) => {
    approvedUnsandboxed.delete(event.toolCallId);
    const requested = planCalls.get(event.toolCallId);
    if (requested === undefined) return;
    planCalls.delete(event.toolCallId);
    if (!showPlanSucceeded(event.isError, event.result)) return;
    // Only a plan shown in a planning mode (the "@plan" prompt) is offered:
    // elsewhere show_plan is plain display, and a model must not be able to
    // put "switch to the approve mode" in front of the user from any mode it likes.
    if (currentMode().systemPrompt !== PLAN_PROMPT_SENTINEL) return;
    const planPath = shownPlanPath(event.result, requested);
    // The path ends up in a user-authored message: plain names only.
    if (!SAFE_PLAN_PATH.test(planPath)) return;
    const sha = planHash(root, planPath);
    pendingPlan = { path: planPath, declined: false, ...(sha ? { sha } : {}) };
    planShownThisRun = true;
    pi.appendEntry<PlanEntry>(PLAN_ENTRY, { path: planPath, ...(sha ? { sha } : {}) });
  });

  // Inject the sandbox-awareness section and the active mode's system prompt
  // (if any). The handler runs each turn and reads the live mode + sandbox
  // state, so it auto-updates when the mode changes. The "@plan" sentinel
  // resolves to the date-stamped Plan-mode prompt. A mode picked as the
  // implicit headless fallback keeps the FACTUAL awareness section (boundary
  // knowledge helps a worker avoid failing commands) but skips the mode's
  // STEERING systemPrompt, which would misdirect a headless worker.
  pi.on("before_agent_start", async (event) => {
    applyToolVisibility(); // keep hidden tools hidden as the tool set evolves
    const m = currentMode();
    const parts: string[] = [];
    // The effective profile carries the session's blocked paths in denyRead,
    // so the model sees them under "Reads are broadly allowed EXCEPT".
    const aware = sandboxAwarenessPrompt({ ...m, sandbox: effectiveSandbox(m) }, {
      active: sandbox.ready && !sandbox.disabled,
      reason: sandbox.disabled ? "disabled via --no-sandbox" : sandbox.warn,
      networkOpen: net.open,
      sessionDomains: net.grants(),
      scratchDir,
      strict: effectiveSandboxState(m) === "strict",
    });
    if (aware) parts.push(aware);
    const sp = m.systemPrompt;
    if (sp && !fallbackMode) {
      parts.push(sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp);
    }
    if (parts.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...parts].join("\n\n") };
  });

  // Skill gating: skills aren't tools — they're invoked via `/skill:<name>` text,
  // so intercept the input before expansion and resolve the `skill` surface.
  pi.on("input", async (event, ctx) => {
    const match = /^\/skill:([\w-]+)/.exec(event.text.trim());
    if (!match) return undefined;
    const name = match[1];
    const action = decide(currentMode(), "skill", name);
    if (action === "deny") {
      if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" blocked in ${currentMode().label}`, "warning");
      return { action: "handled" as const };
    }
    if (
      action === "ask" &&
      !(await promptAllow(ctx, "skill", name, `Skill "${name}" — first use in ${currentMode().label}; allow?`, learnForever(ctx, "skill", name), undefined, { tool: `skill:${name}`, input: { skill: name } }))
    ) {
      return { action: "handled" as const };
    }
    return undefined; // allow → continue to expansion
  });

  pi.on("tool_call", async (event, ctx) => {
    uiCtx = ctx;
    const { toolName } = event;
    const m = currentMode();
    // `input` is a discriminated union across tools; view it loosely (custom
    // tools surface as Record<string, unknown> anyway) and guard each field.
    const input = event.input as Record<string, unknown>;
    if (toolName === "show_plan" && typeof input.path === "string") planCalls.set(event.toolCallId, resolvePlanPath(input.path));
    // Judge the path pi will actually open: `~`, a leading `@`, and `file://`
    // are normalized by pi's file tools before the open (see normalizeToolPath).
    const inPath = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
    if (inPath !== undefined && inPath.includes("\0")) {
      return { block: true, reason: "Path contains a NUL byte" };
    }
    // The mode's sandbox-writable dirs (/tmp, …) are in-bounds: a path the
    // sandbox already permits is not an escape, so it must neither prompt as
    // "outside project" nor — worse — run unsandboxed once the user approves.
    const bounds = sandboxAllowedRoots(root, effectiveSandbox(m));

    // Hard backstop: never write to protected paths (file tools aren't sandboxed),
    // unless the mode explicitly trusts everything (a mode with `bypassProtectedPaths`). Matched lexically AND
    // on the symlink-resolved canonical path, so a link can't smuggle the write.
    if (!m.bypassProtectedPaths && (toolName === "edit" || toolName === "write") && inPath !== undefined) {
      if (isProtectedWrite(root, inPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${inPath}`, "warning");
        return { block: true, reason: `Path "${inPath}" is protected` };
      }
    }

    // Bash.
    if (toolName === "bash") {
      const command = String(input.command ?? "");
      // Fast path: non-sandboxing modes skip AST escape analysis, but still
      // honor their explicit bash policy. Bypass/Accept remains silent because
      // its policy is `allow`; an unsandboxed `ask` mode must still prompt.
      if (!modeSandbox(m).enabled) {
        const action = decide(m, "bash", command);
        // Without the OS sandbox there is no escape prompt, so the documented
        // layer for out-of-project access is the mode's `external_directory`
        // policy (the sandbox-free analogue of the escape gate). Fold it in
        // most-restrictively: a mode may allow bash and still ask for paths
        // outside the project.
        const analysis = await analyzeBash(command, root, bounds);
        const outside = analysis.outsideReason;
        const effective: Action =
          outside ? mostRestrictive(action, decide(m, "external_directory", command, { isOutside: true })) ?? action : action;
        // Tier 1 whitelist applies here too: with the sandbox off there is no
        // OS confinement, so a read-only command is safe to auto-run — and it
        // saves a classifier call for every whitelisted bash in auto mode.
        if (effective === "ask" && !outside && isSafeBashChain(analysis.commands, command)) return undefined;
        const gate = bashGate(effective, outside, false, sandbox.ready);
        if (gate.kind === "block") return { block: true, reason: gate.reason };
        if (gate.kind === "prompt") {
          // Without an AST parse, scope a session grant to the exact command.
          if (
            !(await promptAllow(ctx, "bash", command, gate.title, undefined, undefined, {
              tool: "bash",
              input: { command },
              escalateToHuman: gate.onApproveUnsandboxed,
            }))
          ) {
            return { block: true, reason: gate.reason };
          }
          if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
        }
        return undefined;
      }
      // Real AST when available: judge each (possibly nested) command against the
      // bash surface AND the cross-cutting path gate (joined string + each token,
      // see decideBashCommand), most-restrictive across the chain; detect
      // escapes/privilege.
      const analysis = await analyzeBash(command, root, bounds);
      // A command no layer matches falls back to "ask" (see decideBashChain).
      const action: Action =
        analysis.commands.length > 0 ? decideBashChain(m, analysis.commands) : decide(m, "bash", command);
      const safeChain = isSafeBashChain(analysis.commands, command);
      // Tier 1 fast path: a known read-only command in-bounds runs without prompting
      // or classifier review (shared by Ask / Edits / Auto). Escapes never qualify.
      if (action === "ask" && !analysis.outsideReason && safeChain) {
        return undefined;
      }
      // A read-only, non-privilege out-of-project access under a sandbox that WILL
      // enforce is not a real escape (the sandbox already permits outside reads):
      // keep it sandboxed and let the policy/classifier gate it — instead of
      // escalating to a human and running it UNSANDBOXED once approved.
      const benignOutsideRead = isBenignOutsideRead({
        outsideReason: analysis.outsideReason,
        safeChain,
        usedFallback: analysis.usedFallback,
        sandboxEnabled: modeSandbox(m).enabled,
        sandboxState: effectiveSandboxState(m),
        sandboxReady: sandbox.ready,
      });
      // `escape` drives the prompt/keys/targets below; the classifier still sees
      // `isOutside` from the raw reason, so it can deny a secret read on its own.
      const escape = Boolean(analysis.outsideReason) && !benignOutsideRead;
      const strict = effectiveSandboxState(m) === "strict";
      // In the `strict` sandbox state the boundary is hard: out-of-project access
      // is blocked outright (no prompt, no escape) — the OS cannot mask system
      // reads, so this is enforced at the policy layer.
      if (strict && analysis.outsideReason) {
        return {
          block: true,
          reason: `Sandbox strict: outside-project access is blocked (${analysis.outsideReason})`,
        };
      }
      const gate = bashGate(action, escape ? analysis.outsideReason : undefined, modeSandbox(m).enabled, sandbox.ready);
      // A benign outside read still needs the prompt to say WHY; without the
      // escape branch it would just read "Allow bash?". Make clear it stays
      // sandboxed (unlike a real escape, which runs unsandboxed on approval).
      if (benignOutsideRead && gate.kind === "prompt") {
        gate.title = `Allow bash? (${analysis.outsideReason}; runs inside the sandbox)`;
      }
      if (gate.kind === "block") return { block: true, reason: gate.reason };
      if (gate.kind === "prompt") {
        // Session approvals are keyed on the extracted command names, and ALL
        // names in a chain must be granted for it to pass silently - "allow git
        // this session" must not cover `git status && curl ... | sh`. Granting
        // remembers every name in the chain. Without a parse (heuristic
        // fallback), the key is the exact command string.
        //
        // An ESCAPE (out-of-project path, privilege escalation) is keyed on the
        // exact command string instead: it runs UNSANDBOXED once approved, so a
        // name-level grant earned by an in-project `cat README.md` must never
        // let `cat ~/.ssh/id_rsa` through silently, and an approved escape must
        // not cover a different one that merely shares its command name.
        const names = [...new Set(analysis.commands.map((c) => c.name).filter(Boolean))];
        const keys = escape ? [`escape:${command}`] : names.length > 0 ? names : [command];
        // Paths this command reaches outside the project (none for privilege
        // escalation). One already blocked this session: block outright, no
        // prompt. Otherwise the prompt offers "Deny and block".
        const targets = escape && analysis.outsideReason?.startsWith("path outside project")
          ? analysis.usedFallback
            ? [escapeTargetFromReason(analysis.outsideReason, root)].filter((t): t is string => t !== undefined)
            : escapingPaths(analysis.commands, root, bounds)
          : [];
        const hit = targets.map((t) => canonicalPath(root, t)).find((t) => blocked.covers(t));
        if (hit) return { block: true, reason: `Path ${displayPath(hit)} is blocked for this session (Deny and block); /perm unblock lifts it` };
        if (
          !(await promptAllow(ctx, "bash", keys, gate.title, undefined, denyAndBlock(ctx, targets), {
            tool: "bash",
            input: { command },
            isOutside: Boolean(analysis.outsideReason),
            escalateToHuman: gate.onApproveUnsandboxed,
          }))
        )
          return { block: true, reason: gate.reason };
        if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    // File tools (read/edit/write/ls/grep/find).
    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      const path = inPath;
      // A path blocked for the session ("Deny and block") is denied outright:
      // the file tools are not sandboxed, so the kernel mask alone would not cover them.
      if (blocked.covers(canonicalPath(root, path))) {
        return { block: true, reason: `Path "${path}" is blocked for this session (Deny and block); /perm unblock lifts it` };
      }
      const outside = isOutside(root, path, bounds);
      // Sandbox `strict`: the boundary is hard for file tools too.
      if (effectiveSandboxState(m) === "strict" && outside) {
        return { block: true, reason: `Sandbox strict: outside-project access is blocked (${path})` };
      }
      const action = decide(m, surface, path, { isOutside: outside });
      if (action === "deny") {
        // Friendly message for a Markdown-only write policy (e.g. Plan Mode).
        const policy = m.permission[surface];
        const markdownOnly =
          (surface === "edit" || surface === "write") &&
          typeof policy === "object" &&
          policy !== null &&
          policy["*"] === "deny";
        if (markdownOnly) {
          if (ctx.hasUI) ctx.ui.notify(`${m.label} allows editing Markdown files only: ${path}`, "warning");
          return { block: true, reason: `${m.label} allows editing Markdown files only` };
        }
        return { block: true, reason: `Path "${path}" is blocked by ${m.label}` };
      }
      if (action === "ask") {
        const title = outside ? `Outside project - allow ${toolName}? (${path})` : `Allow ${toolName}? (${path})`;
        const reason = outside ? "Access outside project blocked" : "blocked";
        const denyAnd = outside ? denyAndBlock(ctx, [path]) : undefined;
        if (!(await promptAllow(ctx, surface, path, title, undefined, denyAnd, { tool: toolName, input: { path }, isOutside: outside }))) return { block: true, reason };
      }
      return undefined; // allow
    }

    // web_search.
    if (toolName === "web_search") {
      const action = decide(m, "web_search", String(input.query ?? "(empty)"));
      if (action === "deny") return { block: true, reason: `web search blocked by ${m.label}` };
      // Session approval is surface-wide ("allow web search this session").
      if (
        action === "ask" &&
        !(await promptAllow(ctx, "web_search", "*", "Allow web search?", undefined, undefined, {
          tool: "web_search",
          input: { query: String(input.query ?? "") },
        }))
      ) {
        return { block: true, reason: "web search blocked" };
      }
      return undefined;
    }

    // Custom / extension tools (incl. any MCP-as-tool): gate by tool name. An
    // unknown tool prompts first-use (allow once/session/forever/deny).
    if (!BUILTIN_HANDLED.has(toolName)) {
      const action = decide(m, "tool", toolName);
      if (action === "deny") return { block: true, reason: `Tool "${toolName}" blocked by ${m.label}` };
      if (
        action === "ask" &&
        !(await promptAllow(ctx, "tool", toolName, `Tool "${toolName}" — first use in ${m.label}; allow?`, learnForever(ctx, "tool", toolName), undefined, { tool: toolName, input }))
      ) {
        return { block: true, reason: "tool blocked" };
      }
    }

    return undefined;
  });
}
