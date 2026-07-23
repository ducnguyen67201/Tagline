import { describe, expect, it } from "vitest"

import { bootstrapFixture } from "@/test/fixtures"

import { bootstrapSchema } from "./bootstrap"
import { codexChatStateSchema } from "./agent"
import { founderInputSchema } from "./founder"
import {
  browserCaptureInputSchema,
  browserReplyPreparationSchema,
  browserRunProgressSchema,
  prepareBrowserReplyInputSchema,
} from "./browser"
import { historyPreviewSchema } from "./history"
import {
  browserInboxScanResultSchema,
  conversationSchema,
  emailNotificationSyncResultSchema,
} from "./inbox"
import {
  growthLoopOverviewSchema,
  proposeGrowthActionInputSchema,
  recordGrowthActionMetricInputSchema,
} from "./growth"
import { beginOAuthInputSchema } from "./platform"

describe("boundary schemas", () => {
  it("accepts the versioned bootstrap contract", () => {
    expect(bootstrapSchema.parse(bootstrapFixture).schemaVersion).toBe(1)
  })

  it("accepts a bounded persistent Codex chat transcript", () => {
    expect(
      codexChatStateSchema.parse({
        threadId: "thread-1",
        messages: [
          {
            id: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
            role: "user",
            body: "Find my ICP",
          },
          {
            id: "2e5745e4-1aaf-4e8a-86a6-5e5de8245daa",
            role: "assistant",
            body: "Let us inspect the evidence.",
          },
        ],
      }).messages,
    ).toHaveLength(2)
  })

  it("rejects an empty founder profile", () => {
    expect(
      founderInputSchema.safeParse({
        name: "",
        productName: "",
        websiteUrl: "",
        offer: "",
        idealCustomer: "",
        expertise: "",
        goals: [],
        boundaries: [],
      }).success,
    ).toBe(false)
  })

  it("requires local OAuth account identifiers", () => {
    expect(
      beginOAuthInputSchema.safeParse({
        platform: "x",
        clientId: "",
        remoteAccountId: "",
        displayName: "",
        scopes: [],
      }).success,
    ).toBe(false)
  })

  it("validates local email notification inbox boundaries", () => {
    expect(
      conversationSchema.safeParse({
        id: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        platform: "linkedin",
        remoteId: "email:message-1",
        kind: "direct_message",
        displayName: "Mina",
        preview: "Can we compare notes?",
        unreadCount: 1,
        replyCapability: "unsupported",
        remoteUrl: "https://www.linkedin.com/messaging/",
        source: "email_notification",
        contentState: "notification_excerpt",
        updatedAt: "2026-07-23T18:00:00Z",
      }).success,
    ).toBe(true)
    expect(
      emailNotificationSyncResultSchema.safeParse({
        source: "apple_mail",
        scanned: 3,
        imported: 2,
        ignored: 1,
        duplicates: 0,
        platformCounts: { x: 1, reddit: 0, linkedin: 1 },
        lastCheckedAt: "2026-07-23T18:00:00Z",
      }).success,
    ).toBe(true)
    expect(
      emailNotificationSyncResultSchema.safeParse({
        source: "browser_scrape",
        scanned: 0,
        imported: 0,
        ignored: 0,
        duplicates: 0,
        platformCounts: { x: 0, reddit: 0, linkedin: 0 },
        lastCheckedAt: "2026-07-23T18:00:00Z",
      }).success,
    ).toBe(false)
  })

  it("accepts an honest partial browser inbox scan result", () => {
    expect(
      browserInboxScanResultSchema.parse({
        platform: "linkedin",
        status: "partial",
        scanned: 500,
        imported: 480,
        updated: 20,
        lastScannedAt: "2026-07-23T19:05:00Z",
        message: "LinkedIn stopped loading older rows. Scan again to continue.",
        targetUrl: "https://www.linkedin.com/messaging/",
      }).status,
    ).toBe("partial")
  })

  it("rejects unknown fields on browser research inputs", () => {
    expect(
      browserCaptureInputSchema.safeParse({
        tabId: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        mode: "visible",
        ownership: "reference",
        arbitraryJavaScript: "window.submit()",
      }).success,
    ).toBe(false)
  })

  it("validates an exact browser reply preparation without implying it was submitted", () => {
    expect(
      prepareBrowserReplyInputSchema.safeParse({
        tabId: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        url: "https://x.com/founder/status/1",
        reply: "This is the exact reviewed reply.",
      }).success,
    ).toBe(true)
    expect(
      browserReplyPreparationSchema.parse({
        status: "prepared",
        platform: "x",
        characterCount: 33,
        savedReply: {
          id: "c0d9a1c8-2198-43f1-bde8-c63cd3be7e9a",
          platform: "x",
          targetUrl: "https://x.com/founder/status/1",
          exactReply: "This is the exact reviewed reply.",
          status: "prepared",
          preparedAt: "2026-07-23T18:00:00Z",
          confirmedPostedAt: null,
        },
      }).status,
    ).toBe("prepared")
  })

  it("accepts versioned history and run-state contracts", () => {
    expect(
      browserRunProgressSchema.parse({
        runId: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        status: "paused",
        step: 2,
        itemCount: 4,
        newItemCount: 0,
        pauseReason: "verification_required",
        summary: null,
      }).status,
    ).toBe("paused")
    expect(
      historyPreviewSchema.safeParse({
        schemaVersion: 1,
        selectionId: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        platform: "x",
        parserVersion: "x-archive-v1",
        displayName: "archive.zip",
        accountHandle: null,
        categories: [],
        estimatedRecords: 0,
        earliestAt: null,
        latestAt: null,
        warnings: [],
        unsupportedMembers: [],
        sourceFingerprint: "synthetic",
      }).success,
    ).toBe(true)
  })

  it("validates controlled growth actions and metric availability", () => {
    expect(
      proposeGrowthActionInputSchema.safeParse({
        kind: "comment",
        platform: "x",
        title: "Join a relevant conversation",
        rationale: "The author matches ICP v2.",
        targetUrl: "https://x.com/founder/status/1",
        exactPayload: "A specific, useful comment.",
        hypothesis: "Specific comments create qualified replies.",
        successMetric: "One qualified reply in seven days.",
        evaluationWindowDays: 7,
      }).success,
    ).toBe(true)
    expect(
      recordGrowthActionMetricInputSchema.safeParse({
        actionId: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
        metricName: "qualified_replies",
        value: null,
        availability: "available",
        sourceDefinition: "Founder verified the reply.",
        notes: "",
        observedAt: "2026-07-23T00:00:00Z",
      }).success,
    ).toBe(false)
    expect(
      growthLoopOverviewSchema.safeParse({
        schemaVersion: 1,
        activeIcp: null,
        actions: [],
        learnings: [],
        totals: { proposed: 0, approved: 0, completed: 0, measured: 0 },
      }).success,
    ).toBe(true)
  })
})
