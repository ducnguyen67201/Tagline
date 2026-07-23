import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invokeOutput: vi.fn(),
  invokeValidated: vi.fn(),
  writeText: vi.fn(),
  openUrlInPlatform: vi.fn(),
}))

vi.mock("@/lib/tauri", () => ({
  isTauriRuntime: () => true,
  invokeOutput: mocks.invokeOutput,
  invokeValidated: mocks.invokeValidated,
}))

vi.mock("@/features/browser/useBrowserSurface", () => ({
  useBrowserSurface: () => ({
    surfaceRef: { current: null },
    activeTab: null,
    error: null,
    isNative: true,
    openUrlInPlatform: mocks.openUrlInPlatform,
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
  }),
}))

import { InboxPage } from "./InboxPage"

const notifications = [
  {
    id: "b9d7afe0-1807-4ad9-bf22-2945f0bb9081",
    platform: "x",
    remoteId: "email:x-message-1",
    kind: "comment_thread",
    displayName: "Ari",
    preview: "A thoughtful response",
    unreadCount: 1,
    replyCapability: "unsupported",
    remoteUrl: "https://x.com/ari/status/1",
    source: "email_notification",
    contentState: "notification_excerpt",
    updatedAt: "2026-07-23T18:00:00Z",
  },
  {
    id: "2e5745e4-1aaf-4e8a-86a6-5e5de8245daa",
    platform: "reddit",
    remoteId: "email:reddit-message-1",
    kind: "direct_message",
    displayName: "u/founder",
    preview: "Can we compare notes?",
    unreadCount: 0,
    replyCapability: "unsupported",
    remoteUrl: "https://www.reddit.com/message/inbox",
    source: "email_notification",
    contentState: "notification_excerpt",
    updatedAt: "2026-07-23T17:00:00Z",
  },
  {
    id: "b4be48f1-b73b-4da8-b8e5-4fc4bac517ef",
    platform: "linkedin",
    remoteId: "email:linkedin-message-1",
    kind: "direct_message",
    displayName: "Mina",
    preview: "A new message",
    unreadCount: 1,
    replyCapability: "unsupported",
    remoteUrl: "https://www.linkedin.com/messaging/",
    source: "email_notification",
    contentState: "link_only",
    updatedAt: "2026-07-23T16:00:00Z",
  },
] as const

function renderInbox() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <InboxPage />
    </QueryClientProvider>,
  )
}

describe("InboxPage email notifications", () => {
  beforeEach(() => {
    mocks.invokeOutput.mockReset()
    mocks.invokeValidated.mockReset()
    mocks.writeText.mockReset()
    mocks.openUrlInPlatform.mockReset()
    mocks.openUrlInPlatform.mockResolvedValue({ id: "browser-tab" })
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    })
    mocks.writeText.mockResolvedValue(undefined)
    mocks.invokeOutput.mockImplementation((command: string) => {
      if (command === "list_conversations") return Promise.resolve(notifications)
      if (command === "sync_email_notifications") {
        return Promise.resolve({
          source: "apple_mail",
          scanned: 3,
          imported: 2,
          ignored: 1,
          duplicates: 0,
          platformCounts: { x: 1, reddit: 0, linkedin: 1 },
          lastCheckedAt: "2026-07-23T19:00:00Z",
        })
      }
      throw new Error(`Unexpected output command: ${command}`)
    })
    mocks.invokeValidated.mockImplementation((command: string, args?: { input?: { platform?: string } }) => {
      if (command === "mark_conversation_read") return Promise.resolve(true)
      if (command === "draft_reply") return Promise.resolve({ options: ["Thanks for reaching out."] })
      if (command === "scan_browser_inbox") {
        const platform = args?.input?.platform
        if (platform === "reddit") {
          return Promise.resolve({
            platform,
            status: "needs_browser",
            scanned: 0,
            imported: 0,
            updated: 0,
            lastScannedAt: "2026-07-23T19:05:00Z",
            message: "Open Reddit in Goalbar Browser and sign in before scanning.",
            targetUrl: "https://www.reddit.com/message/inbox",
          })
        }
        return Promise.resolve({
          platform,
          status: "completed",
          scanned: platform === "x" ? 5 : 2,
          imported: platform === "x" ? 5 : 2,
          updated: 0,
          lastScannedAt: "2026-07-23T19:05:00Z",
          message: `Imported recent ${platform} conversations.`,
          targetUrl: platform === "x" ? "https://x.com/messages" : "https://www.linkedin.com/messaging/",
        })
      }
      if (command === "approve_reply") {
        return Promise.resolve({
          id: "3d9ed322-73aa-4e18-98ea-b8a0c67ee0e0",
          subjectType: "reply",
          subjectId: notifications[0].id,
          payloadHash: "hash",
          idempotencyKey: "cecf1059-1959-43f7-979e-fba6d7861985",
          approvedAt: "2026-07-23T19:00:00Z",
        })
      }
      if (command === "open_remote_url") return Promise.resolve(undefined)
      throw new Error(`Unexpected validated command: ${command}`)
    })
  })

  it("checks all three platforms and filters what is new", async () => {
    const user = userEvent.setup()
    renderInbox()

    expect(await screen.findByText("Ari")).toBeInTheDocument()
    expect(screen.getByText("u/founder")).toBeInTheDocument()
    expect(screen.getByText("Mina")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /New 2/ }))
    expect(screen.getByText("Ari")).toBeInTheDocument()
    expect(screen.getByText("Mina")).toBeInTheDocument()
    expect(screen.queryByText("u/founder")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Check Apple Mail" }))
    expect((await screen.findAllByText("2 new")).length).toBeGreaterThan(0)
    expect(screen.getByText("1 X · 0 Reddit · 1 LinkedIn")).toBeInTheDocument()
  })

  it("searches locally across names, previews, and platforms with composable filters", async () => {
    const user = userEvent.setup()
    renderInbox()

    const search = screen.getByRole("searchbox", { name: "Search conversations" })
    await screen.findByText("Ari")

    await user.type(search, "compare notes")
    expect(screen.getByText("u/founder")).toBeInTheDocument()
    expect(screen.queryByText("Ari")).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "linkedin")
    expect(screen.getByText("Mina")).toBeInTheDocument()
    expect(screen.queryByText("u/founder")).not.toBeInTheDocument()

    await user.clear(search)
    await user.click(screen.getByRole("button", { name: /Reddit 1/ }))
    await user.click(screen.getByRole("button", { name: /New 2/ }))
    expect(screen.getByText("No conversations found")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /New 2/ }))
    expect(screen.getByText("u/founder")).toBeInTheDocument()
  })

  it("marks a signal read and keeps sending on the platform", async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    })
    renderInbox()

    await user.click(await screen.findByRole("button", { name: /Ari/ }))
    await waitFor(() =>
      expect(mocks.invokeValidated).toHaveBeenCalledWith(
        "mark_conversation_read",
        { input: { conversationId: notifications[0].id } },
        expect.anything(),
        expect.anything(),
      ),
    )
    expect(screen.getByText(/Open the platform to verify the full conversation/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Draft with Codex" }))
    expect(await screen.findByDisplayValue("Thanks for reaching out.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Approve exact text" }))
    await user.click(await screen.findByRole("button", { name: "Copy approved text" }))
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith("Thanks for reaching out."))

    await user.click(screen.getByRole("button", { name: /^Open platform$/ }))
    expect(mocks.invokeValidated).toHaveBeenCalledWith(
      "open_remote_url",
      { url: "https://x.com/ari/status/1" },
      expect.anything(),
      expect.anything(),
    )
    expect(mocks.invokeValidated).not.toHaveBeenCalledWith(
      "send_reply",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it("opens the selected conversation in the integrated browser pane", async () => {
    const user = userEvent.setup()
    renderInbox()

    await user.click(await screen.findByRole("button", { name: /Ari/ }))

    expect(await screen.findByRole("region", { name: "Live x thread" })).toBeInTheDocument()
    expect(screen.getByText("Live platform thread")).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.openUrlInPlatform).toHaveBeenCalledWith("https://x.com/ari/status/1", "x"),
    )
  })

  it("provides explicit browser scans for X, Reddit, and LinkedIn", async () => {
    const user = userEvent.setup()
    renderInbox()

    await screen.findByText("Ari")
    await user.click(screen.getByText("Scan inbox"))
    await user.click(screen.getByRole("button", { name: "Scan X inbox" }))
    expect(await screen.findByText("5 conversations · 5 new · 0 updated")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Scan Reddit inbox" }))
    expect(
      await screen.findByText("Open Reddit in Goalbar Browser and sign in before scanning."),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Scan LinkedIn inbox" }))
    expect(await screen.findByText("2 conversations · 2 new · 0 updated")).toBeInTheDocument()

    for (const platform of ["x", "reddit", "linkedin"]) {
      expect(mocks.invokeValidated).toHaveBeenCalledWith(
        "scan_browser_inbox",
        { input: { platform } },
        expect.anything(),
        expect.anything(),
      )
    }
  })

  it("shows imported counts when a history scan is partial", async () => {
    const user = userEvent.setup()
    mocks.invokeValidated.mockResolvedValueOnce({
      platform: "linkedin",
      status: "partial",
      scanned: 500,
      imported: 480,
      updated: 20,
      lastScannedAt: "2026-07-23T19:05:00Z",
      message: "LinkedIn stopped loading older rows. Scan again to continue.",
      targetUrl: "https://www.linkedin.com/messaging/",
    })
    renderInbox()

    await user.click(screen.getByRole("button", { name: "Scan LinkedIn inbox" }))

    expect(await screen.findByText("500 conversations · 480 new · 20 updated")).toBeInTheDocument()
    expect(
      screen.getByText("LinkedIn stopped loading older rows. Scan again to continue."),
    ).toBeInTheDocument()
  })
})
