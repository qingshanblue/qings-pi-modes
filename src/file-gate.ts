/**
 * Pure gate for the built-in file tools (read/write/edit/ls/grep/find).
 *
 * The file tools are never sandboxed, so this module only decides allow / block
 * / ask from the mode's policy and the path's position. The dispatcher (index.ts)
 * owns the side effects: the session block list, the prompt itself, and the
 * "Deny and block" option. SDK-free.
 */

import { compactTitle, FILE_TOOL_VERB } from "./action.ts";
import { decide } from "./resolve.ts";
import type { ModeDef, Surface } from "./schema.ts";

export interface FileGateInput {
  mode: ModeDef;
  surface: Surface;
  toolName: string;
  path: string;
  /** The path lies outside the project (and outside any granted root). */
  outside: boolean;
  /** The effective sandbox state is `strict`: outside access is a hard block. */
  strict: boolean;
}

export type FileGate =
  | { kind: "allow" }
  | { kind: "block"; reason: string; notice?: string }
  | { kind: "ask"; title: string; reason: string };

export function gateFileTool(input: FileGateInput): FileGate {
  const { mode, surface, toolName, path, outside } = input;
  if (input.strict && outside) {
    return { kind: "block", reason: `Sandbox strict: outside-project access is blocked (${path})` };
  }
  const action = decide(mode, surface, path, { isOutside: outside });
  if (action === "deny") {
    // Friendly message for a Markdown-only write policy (e.g. Plan Mode).
    const policy = mode.permission[surface];
    const markdownOnly =
      (surface === "edit" || surface === "write") && typeof policy === "object" && policy !== null && policy["*"] === "deny";
    if (markdownOnly) {
      const message = `${mode.label} allows editing Markdown files only`;
      return { kind: "block", reason: message, notice: `${message}: ${path}` };
    }
    return { kind: "block", reason: `Path "${path}" is blocked by ${mode.label}` };
  }
  if (action === "ask") {
    const verb = FILE_TOOL_VERB[toolName] ?? toolName;
    const title = outside ? `Outside project - allow ${verb} ${compactTitle(path, 120)}?` : `Allow ${verb} ${compactTitle(path, 120)}?`;
    return { kind: "ask", title, reason: outside ? "Access outside project blocked" : "blocked" };
  }
  return { kind: "allow" };
}
