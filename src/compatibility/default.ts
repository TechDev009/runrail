import { RUNRAIL_VERSION } from "../version.ts"
import { parsePiCompatibilityMatrix, type PiCompatibilityMatrix } from "./matrix.ts"

/** The locked feature inventory for the Pi 0.84.1 compatibility target. */
export function createDefaultPiCompatibilityMatrix(): PiCompatibilityMatrix {
  return parsePiCompatibilityMatrix({
    schemaVersion: 1,
    piVersion: "0.84.1",
    runrailVersion: RUNRAIL_VERSION,
    features: [
      feature("cli.options", "CLI options", "cli", "pass-through", "pi.cli", "pi-cli-help", "Pi owns argument parsing and credentials", "verified", "Pi remains the transparent escape hatch"),
      feature("interactive.editor", "Interactive editor", "interactive", "native", "pi.editor", "pi-interactive-editor", "Terminal input is bounded and cancellation-safe", "verified"),
      feature("interactive.commands", "Interactive commands", "interactive", "native", "pi.commands", "pi-interactive-commands", "Commands must be registered and capability-checked", "verified"),
      feature("interactive.hotkeys", "Interactive hotkeys", "interactive", "native", "pi.hotkeys", "pi-interactive-hotkeys", "Unsupported terminals degrade to readline or JSON", "verified"),
      feature("interactive.message-queue", "Message queue and steering", "interactive", "native", "pi.message-queue", "pi-message-queue", "Queue length and cancellation are bounded", "verified"),
      feature("session.lifecycle", "Sessions and recovery", "sdk", "native", "pi.sessions", "pi-session-lifecycle", "Transcript payloads stay in the caller-owned store", "verified"),
      feature("session.compaction", "Compaction", "sdk", "native", "pi.compaction", "pi-session-compaction", "Compaction must preserve branch identity and refuse unknown versions", "verified"),
      feature("resource.context", "Context files", "resource", "native", "pi.context", "pi-context-files", "Files are resolved under the workspace policy", "verified"),
      feature("resource.templates", "Prompt templates", "resource", "native", "pi.templates", "pi-prompt-templates", "Templates are bounded and never persisted as evidence", "verified"),
      feature("resource.skills", "Skills", "resource", "native", "pi.skills", "pi-skills", "Skill precedence and reload are deterministic", "verified"),
      feature("resource.extensions", "Extensions", "package", "adapter", "pi.extensions", "pi-extension-adapter", "Explicitly approved Pi-compatible extensions run through the versioned native adapter; arbitrary Pi code is never activated implicitly", "verified", "Full Pi UI component and provider package behavior remains Pi pass-through or caller-owned"),
      feature("resource.themes", "Themes", "resource", "native", "pi.themes", "pi-themes", "Theme input is local and bounded", "verified"),
      feature("package.install", "Packages", "package", "adapter", "pi.packages", "pi-package-adapter", "Remote package fetching remains caller-owned", "unavailable", "Safe Pi inspection is available through inspect-pi; automatic Pi package activation requires explicit migration to a Runrail manifest"),
      feature("provider.protocols", "Providers", "provider", "adapter", "pi.providers", "pi-provider-protocols", "Provider adapters never persist credentials or raw payloads", "verified"),
      feature("provider.auth", "Authentication", "provider", "caller-owned", "pi.auth", "pi-auth", "Credentials and subscriptions remain caller- or desktop-owned", "verified", "Runrail resolves ephemeral references but does not own accounts"),
      feature("sdk.session", "SDK session API", "sdk", "native", "pi.sdk", "pi-sdk-session", "SDK callers receive bounded events and explicit close behavior", "verified"),
      feature("rpc.events", "RPC and JSONL events", "rpc", "adapter", "pi.rpc", "pi-rpc-events", "Framing, event bounds, and redaction fail closed", "verified"),
      feature("rpc.refusal", "Unsupported RPC refusal", "rpc", "adapter", "pi.rpc.refusal", "pi-rpc-refusal", "Unknown protocol versions are refused before activation", "verified"),
      feature("session.import-export", "Import and export", "sdk", "native", "pi.transfer", "pi-session-transfer", "Payload-bearing transfer is opt-in and caller-owned", "verified"),
      feature("sharing.remote", "Sharing", "sdk", "caller-owned", "pi.sharing", "pi-sharing", "Hosted sharing, retention, and access control stay outside Runrail", "unavailable", "The public seam is caller-owned and disabled by default; no hosted sharing service is bundled"),
      feature("resource.discovery", "Resource discovery", "resource", "adapter", "pi.resources", "pi-resource-discovery", "Discovery cannot fetch or activate untrusted sources implicitly", "verified"),
    ],
  })
}

function feature(
  id: string,
  name: string,
  surface: string,
  classification: string,
  capability: string,
  fixture: string,
  security: string,
  status: string,
  reason?: string,
): Record<string, string> {
  return { id, feature: name, surface, classification, capability, fixture, security, status, ...(reason === undefined ? {} : { reason }) }
}
