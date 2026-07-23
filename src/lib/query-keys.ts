export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  agents: ["agents"] as const,
  accounts: ["accounts"] as const,
  conversations: ["conversations"] as const,
  browserTabs: ["browser-tabs"] as const,
  founderChatSession: ["founder-chat-session"] as const,
  browserRun: (runId: string) => ["browser-run", runId] as const,
  history: ["history-overview"] as const,
  icp: ["icp"] as const,
  growth: ["growth"] as const,
  growthLoop: ["growth-loop"] as const,
}
