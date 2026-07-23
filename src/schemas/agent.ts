import { z } from "zod"

export const agentProviderSchema = z.enum(["codex", "claude"])
export const agentReadinessSchema = z.enum(["missing", "installed", "auth_required", "ready", "incompatible"])

export const agentStatusSchema = z.object({
  provider: agentProviderSchema,
  readiness: agentReadinessSchema,
  path: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
})

export const agentStatusesSchema = z.array(agentStatusSchema)

export const founderChatResearchRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(1_000),
    reason: z.string().trim().min(1).max(1_000),
    ownership: z.enum(["own", "reference"]),
    maximumItems: z.number().int().min(1).max(25),
    maximumSteps: z.number().int().min(1).max(8),
  })
  .strict()

export const engagementSuggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    url: z.url().refine(
      (value) => {
        const parsed = new URL(value)
        const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
        return (
          parsed.protocol === "https:" &&
          ["x.com", "twitter.com", "linkedin.com", "reddit.com"].some(
            (root) => host === root || host.endsWith(`.${root}`),
          )
        )
      },
      { message: "Engagement URLs must use HTTPS on X, LinkedIn, or Reddit" },
    ),
    reason: z.string().trim().min(1).max(2_000),
    reply: z.string().trim().min(1).max(8_000),
  })
  .strict()

export const founderChatTurnSchema = z
  .object({
    reply: z.string().trim().min(1).max(8_000),
    researchRequest: founderChatResearchRequestSchema.nullable(),
  })
  .strict()

export const runAgentTaskInputSchema = z
  .object({
    provider: agentProviderSchema,
    taskKind: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(8_000),
    context: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
  })
  .strict()

export const founderChatAgentResultSchema = z
  .object({
    provider: agentProviderSchema,
    providerVersion: z.string(),
    output: founderChatTurnSchema,
    usage: z.unknown().nullable().optional(),
  })
  .strict()

export const sendCodexChatInputSchema = z
  .object({
    threadId: z.string().min(1),
    message: z.string().trim().min(1).max(20_000),
    activeTabId: z.string().uuid().nullable(),
  })
  .strict()

export const codexChatTurnResultSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    reply: z.string().trim().min(1).max(40_000),
  })
  .strict()

export const codexChatMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    body: z.string().max(40_000),
  })
  .strict()

export const codexChatStateSchema = z
  .object({
    threadId: z.string().min(1).nullable(),
    messages: z.array(codexChatMessageSchema).max(200),
    browserAccessEnabled: z.boolean(),
  })
  .strict()

export const codexChatStatusSchema = z.enum(["not_loaded", "idle", "active", "system_error"])

export const codexChatSummarySchema = z
  .object({
    threadId: z.string().min(1),
    title: z.string().trim().min(1).max(64),
    preview: z.string(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    status: codexChatStatusSchema,
  })
  .strict()

export const codexChatCollectionSchema = z
  .object({
    activeThreadId: z.string().min(1),
    chats: z.array(codexChatSummarySchema).min(1).max(100),
  })
  .strict()

export const selectCodexChatInputSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .strict()

export const interruptCodexChatInputSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .strict()

export const deleteCodexChatInputSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .strict()

export const setCodexChatBrowserAccessInputSchema = z
  .object({
    threadId: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict()

export const codexChatDeletionResultSchema = z
  .object({
    deletedThreadId: z.string().min(1),
    collection: codexChatCollectionSchema,
    activeChat: codexChatStateSchema,
  })
  .strict()

export const codexChatEventSchema = z
  .object({
    kind: z.enum([
      "turn_started",
      "assistant_delta",
      "tool_started",
      "tool_completed",
      "turn_completed",
      "state_changed",
    ]),
    threadId: z.string(),
    turnId: z.string().nullable(),
    delta: z.string().nullable(),
    tool: z.string().nullable(),
    message: z.string().nullable(),
    success: z.boolean().nullable(),
  })
  .strict()

export const founderChatOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "researchRequest"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 8_000 },
    researchRequest: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["objective", "reason", "ownership", "maximumItems", "maximumSteps"],
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 1_000 },
            reason: { type: "string", minLength: 1, maxLength: 1_000 },
            ownership: { type: "string", enum: ["own", "reference"] },
            maximumItems: { type: "integer", minimum: 1, maximum: 25 },
            maximumSteps: { type: "integer", minimum: 1, maximum: 8 },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const

export type AgentProvider = z.infer<typeof agentProviderSchema>
export type AgentStatus = z.infer<typeof agentStatusSchema>
export type EngagementSuggestion = z.infer<typeof engagementSuggestionSchema>
export type FounderChatResearchRequest = z.infer<typeof founderChatResearchRequestSchema>
export type FounderChatTurn = z.infer<typeof founderChatTurnSchema>
export type CodexChatSummary = z.infer<typeof codexChatSummarySchema>
export type CodexChatEvent = z.infer<typeof codexChatEventSchema>
export type CodexChatState = z.infer<typeof codexChatStateSchema>
export type CodexChatTurnResult = z.infer<typeof codexChatTurnResultSchema>
