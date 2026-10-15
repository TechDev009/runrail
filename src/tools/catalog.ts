import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { createApplyPatchTool } from "./apply-patch.ts"
import { createEditFileTool } from "./edit-file.ts"
import { createFindFilesTool } from "./find-files.ts"
import { createListFilesTool } from "./list-files.ts"
import { createReadFileTool } from "./read-file.ts"
import type { NativeBackgroundCommands } from "../background/native-commands.ts"
import { createCommandOutputTool, createCommandStopTool, createRunCommandTool } from "./run-command.ts"
import { createRunVerificationTool } from "./run-verification.ts"
import { createSearchFilesTool } from "./search-files.ts"
import { createUpdatePlanTool } from "./update-plan.ts"
import { createWriteFileTool } from "./write-file.ts"

export interface ToolCatalogOptions {
  readonly allowWrite?: boolean
  readonly verificationCommand?: string
  readonly verification?: "check" | "assure" | "test"
  /** Lets `run_command` start background commands, read with `command_output` and ended with `command_stop`. */
  readonly background?: NativeBackgroundCommands
}

export function createToolCatalog(policy: WorkspacePolicy, options: ToolCatalogOptions = {}): readonly NativeTool[] {
  return Object.freeze([
    createReadFileTool(policy),
    createApplyPatchTool(policy, { allowWrite: options.allowWrite }),
    createWriteFileTool(policy, { allowWrite: options.allowWrite }),
    createEditFileTool(policy, { allowWrite: options.allowWrite }),
    createListFilesTool(policy),
    createFindFilesTool(policy),
    createSearchFilesTool(policy),
    createRunCommandTool(policy, options.background),
    ...(options.background === undefined ? [] : [createCommandOutputTool(options.background), createCommandStopTool(options.background)]),
    createRunVerificationTool(policy, {
      command: options.verificationCommand,
      verification: options.verification,
    }),
    createUpdatePlanTool(),
  ])
}
