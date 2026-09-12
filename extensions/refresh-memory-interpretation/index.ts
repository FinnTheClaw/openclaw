import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

const GUIDANCE = [
  "Preserve the meaning of memory in the saved text itself: its source, scope, exceptions, and uncertainty.",
  "Keep limited feedback as a scoped observation or tentative inference in daily notes; use active user",
  "directives for established preferences at their supported scope. Tentative wording in your reply does",
  "not qualify an unconditional directive saved in a file.",
  "Preserve temporal qualifiers such as next time, for this check, or until a stated condition. A",
  "request for a bounded occasion is not an indefinite rule. Repeated examples may support a broader",
  "tentative inference, but preserve their original scope instead of silently promoting that inference",
  "to a standing instruction. This does not downgrade an explicitly ongoing user preference.",
  "",
  "During memory maintenance, retain existing preferences and corrected facts unless the user changes",
  "or deletes them, their recorded end condition applies, or newer evidence contradicts them. An",
  "unavailable original conversation is missing provenance—not evidence that a remembered preference",
  "was invented. Preserve the entry and describe the provenance gap only when relevant.",
  "",
  "Apply explicit user requests to save, update, or forget promptly, preserving stated exceptions and",
  "unrelated valid memory. When updating a preference, supersede the conflicting old rule rather than",
  "leaving both active.",
].join("\n");

export default {
  id: "refresh-memory-interpretation",
  name: "Refresh Memory Interpretation",
  description:
    "Opt-in faithful-memory guidance. Enable this plugin with hooks.allowConversationAccess=true and hooks.allowPromptInjection=true.",
  register(api: OpenClawPluginApi) {
    api.on("before_prompt_build", () => ({ appendSystemContext: GUIDANCE }));
  },
} satisfies OpenClawPluginDefinition;
