import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Inbox,
  MailCheck,
  RefreshCw,
  Search,
  Send,
  Sparkles,
} from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { InboxBrowserPane } from "@/features/inbox/InboxBrowserPane"
import { relativeDate } from "@/lib/dates"
import { queryKeys } from "@/lib/query-keys"
import { invokeOutput, invokeValidated, isTauriRuntime } from "@/lib/tauri"
import { titleCase } from "@/lib/utils"
import { approvalSchema } from "@/schemas/content"
import {
  browserInboxScanInputSchema,
  browserInboxScanResultSchema,
  conversationsSchema,
  emailNotificationSyncResultSchema,
  remoteMessageSchema,
  replyOptionsSchema,
  type Conversation,
} from "@/schemas/inbox"

const draftInputSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  conversationId: z.string().uuid(),
})
const approveInputSchema = z.object({ conversationId: z.string().uuid(), body: z.string().min(1) })
const sendInputSchema = approveInputSchema.extend({
  approvalId: z.string().uuid(),
  recipientId: z.string().optional(),
})
const conversationInputSchema = z.object({ conversationId: z.string().uuid() })
const openUrlSchema = z.url()
type PlatformFilter = "all" | Conversation["platform"]
const inboxFilters: Array<{ value: PlatformFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "x", label: "X" },
  { value: "reddit", label: "Reddit" },
  { value: "linkedin", label: "LinkedIn" },
]

export function InboxPage() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [body, setBody] = useState("")
  const [recipientId, setRecipientId] = useState("")
  const [approvalId, setApprovalId] = useState<string | null>(null)
  const [filter, setFilter] = useState<PlatformFilter>("all")
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [composerOpen, setComposerOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const conversations = useQuery({
    queryKey: queryKeys.conversations,
    queryFn: () =>
      isTauriRuntime() ? invokeOutput("list_conversations", {}, conversationsSchema) : Promise.resolve([]),
  })
  const sync = useMutation({
    mutationFn: () =>
      isTauriRuntime()
        ? invokeOutput("sync_email_notifications", {}, emailNotificationSyncResultSchema)
        : Promise.resolve(
            emailNotificationSyncResultSchema.parse({
              source: "apple_mail",
              scanned: 0,
              imported: 0,
              ignored: 0,
              duplicates: 0,
              platformCounts: { x: 0, reddit: 0, linkedin: 0 },
              lastCheckedAt: new Date().toISOString(),
            }),
          ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.conversations }),
  })
  const browserScan = useMutation({
    mutationFn: (platform: Conversation["platform"]) => {
      const input = { platform }
      return isTauriRuntime()
        ? invokeValidated(
            "scan_browser_inbox",
            { input },
            browserInboxScanInputSchema,
            browserInboxScanResultSchema,
          )
        : Promise.resolve(
            browserInboxScanResultSchema.parse({
              platform,
              status: "completed",
              scanned: 0,
              imported: 0,
              updated: 0,
              lastScannedAt: new Date().toISOString(),
              message: "Browser preview mode does not scan live platform pages.",
              targetUrl:
                platform === "x"
                  ? "https://x.com/messages"
                  : platform === "reddit"
                    ? "https://www.reddit.com/message/inbox"
                    : "https://www.linkedin.com/messaging/",
            }),
          )
    },
    onSuccess: async (result) => {
      if (result.status === "completed" || result.status === "partial") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.conversations })
      }
    },
  })
  const markRead = useMutation({
    mutationFn: (conversationId: string) => {
      const input = { conversationId }
      return isTauriRuntime()
        ? invokeValidated("mark_conversation_read", { input }, conversationInputSchema, z.boolean())
        : Promise.resolve(true)
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.conversations }),
  })
  const draft = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Select a conversation")
      const input = { provider: "codex" as const, conversationId: selected.id }
      if (!isTauriRuntime()) return { options: ["Thanks for asking—here is what I have learned so far."] }
      return invokeValidated("draft_reply", { input }, draftInputSchema, replyOptionsSchema)
    },
    onSuccess: (value) => {
      setBody(value.options[0] ?? "")
      setCopied(false)
    },
  })
  const approve = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Select a conversation")
      const input = { conversationId: selected.id, body }
      if (!isTauriRuntime())
        return approvalSchema.parse({
          id: crypto.randomUUID(),
          subjectType: selected.kind === "direct_message" ? "direct_message" : "reply",
          subjectId: selected.id,
          payloadHash: "preview",
          idempotencyKey: crypto.randomUUID(),
          approvedAt: new Date().toISOString(),
        })
      return invokeValidated("approve_reply", { input }, approveInputSchema, approvalSchema)
    },
    onSuccess: (approval) => setApprovalId(approval.id),
  })
  const send = useMutation({
    mutationFn: async () => {
      if (!selected || !approvalId) throw new Error("Approve this exact text first")
      const input = { conversationId: selected.id, approvalId, body, recipientId: recipientId || undefined }
      if (!isTauriRuntime())
        return remoteMessageSchema.parse({ platform: selected.platform, remoteId: crypto.randomUUID(), body })
      return invokeValidated("send_reply", { input }, sendInputSchema, remoteMessageSchema)
    },
    onSuccess: () => {
      setBody("")
      setApprovalId(null)
      setSelected(null)
    },
  })
  const openPlatform = useMutation({
    mutationFn: (url: string) =>
      isTauriRuntime()
        ? invokeValidated("open_remote_url", { url }, openUrlSchema, z.void())
        : Promise.resolve(),
  })
  const copyApproved = useMutation({
    mutationFn: async () => {
      if (!approvalId) throw new Error("Approve this exact text first")
      await navigator.clipboard.writeText(body)
    },
    onSuccess: () => setCopied(true),
  })

  const newCount = conversations.data?.filter((conversation) => conversation.unreadCount > 0).length ?? 0
  const visibleConversations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    const rows = conversations.data ?? []
    const filteredRows = rows.filter(
      (conversation) =>
        (filter === "all" || conversation.platform === filter) &&
        (!unreadOnly || conversation.unreadCount > 0),
    )

    if (!normalizedSearch) return filteredRows
    return filteredRows.filter((conversation) =>
      [
        conversation.displayName,
        conversation.preview,
        conversation.platform,
        conversation.kind,
        conversation.contentState,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch),
    )
  }, [conversations.data, filter, search, unreadOnly])

  const platformCounts = useMemo(() => {
    const rows = conversations.data ?? []
    return rows.reduce(
      (counts, conversation) => ({
        ...counts,
        [conversation.platform]: counts[conversation.platform] + 1,
      }),
      { all: rows.length, x: 0, reddit: 0, linkedin: 0 },
    )
  }, [conversations.data])

  const selectConversation = (conversation: Conversation) => {
    setSelected({ ...conversation, unreadCount: 0 })
    setBody("")
    setApprovalId(null)
    setCopied(false)
    setComposerOpen(true)
    if (conversation.unreadCount > 0) markRead.mutate(conversation.id)
  }
  const localPreview = selected?.source !== "platform_api"

  const actionError =
    conversations.error ??
    sync.error ??
    browserScan.error ??
    markRead.error ??
    draft.error ??
    approve.error ??
    send.error ??
    openPlatform.error ??
    copyApproved.error

  return (
    <div className="inbox-workbench-page">
      <header className="inbox-command-deck">
        <div className="inbox-command-title">
          <span className="inbox-command-mark" aria-hidden="true">
            <Inbox size={16} />
          </span>
          <div>
            <h1>Inbox</h1>
            <p>Local signals · platform truth</p>
          </div>
        </div>

        <label className="inbox-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search conversations</span>
          <Input
            type="search"
            aria-label="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search people, messages, or platforms"
          />
          {search && <kbd>{visibleConversations.length} found</kbd>}
        </label>

        <div className="inbox-header-actions" aria-label="Inbox scan actions">
          <details className="inbox-scan-menu">
            <summary aria-label="Choose an inbox to scan">
              <RefreshCw size={13} className={browserScan.isPending ? "spin" : undefined} />
              <span>{browserScan.isPending ? "Scanning…" : "Scan inbox"}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </summary>
            <div className="inbox-scan-popover">
              <p>
                <strong>Scan a signed-in tab</strong>
                <span>Free · local · read-only</span>
              </p>
              {(["x", "reddit", "linkedin"] as const).map((platform) => {
                const name = platform === "x" ? "X" : platform === "reddit" ? "Reddit" : "LinkedIn"
                const pending = browserScan.isPending && browserScan.variables === platform
                return (
                  <button
                    key={platform}
                    type="button"
                    aria-label={`Scan ${name} inbox`}
                    onClick={() => browserScan.mutate(platform)}
                    disabled={browserScan.isPending}
                  >
                    <span>{name}</span>
                    <small>{pending ? "Scanning…" : `${platformCounts[platform]} saved`}</small>
                    <RefreshCw size={12} className={pending ? "spin" : undefined} />
                  </button>
                )
              })}
            </div>
          </details>
          <Button
            variant="ghost"
            aria-label="Check Apple Mail"
            title="Check Apple Mail"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
          >
            {sync.isPending ? <RefreshCw size={14} className="spin" /> : <MailCheck size={14} />}
            Mail
          </Button>
        </div>
      </header>

      <div className="inbox-filter-deck" aria-label="Inbox controls">
        <div className="inbox-filter-chips" aria-label="Filter conversations">
          {inboxFilters.map((option) => (
            <button
              key={option.value}
              type="button"
              className="inbox-filter-chip"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              <span>{option.label}</span>
              <strong>{platformCounts[option.value]}</strong>
            </button>
          ))}
          <span className="inbox-filter-divider" aria-hidden="true" />
          <button
            type="button"
            className="inbox-filter-chip inbox-filter-new"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((value) => !value)}
          >
            <span className="unread-dot" aria-hidden="true" />
            <span>New</span>
            <strong>{newCount}</strong>
          </button>
        </div>
        <p className="inbox-source-note">
          <strong>Free local connector</strong>
          <span>Signed-in tabs stay on this machine</span>
        </p>
        {browserScan.data && (
          <div className="inbox-sync-result" role="status">
            <strong>
              {browserScan.data.status === "completed" || browserScan.data.status === "partial"
                ? `${browserScan.data.scanned} conversations · ${browserScan.data.imported} new · ${browserScan.data.updated} updated`
                : `${titleCase(browserScan.data.platform)} needs attention`}
            </strong>
            <span>{browserScan.data.message}</span>
          </div>
        )}
        {sync.data && (
          <div className="inbox-sync-result" role="status">
            <strong>{sync.data.imported} new</strong>
            <span>
              {sync.data.platformCounts.x} X · {sync.data.platformCounts.reddit} Reddit ·{" "}
              {sync.data.platformCounts.linkedin} LinkedIn
            </span>
          </div>
        )}
      </div>

      <div className="inbox-layout">
        <aside className="inbox-conversation-rail" aria-label="Conversation results">
          <div className="inbox-rail-heading">
            <div>
              <span>Attention queue</span>
              <strong>{visibleConversations.length}</strong>
            </div>
            <small>{newCount ? `${newCount} new` : "Up to date"}</small>
          </div>
          <div className="conversation-list">
            {!conversations.isPending && !visibleConversations.length ? (
              <div className="inbox-empty-results">
                <span className="inbox-empty-orbit" aria-hidden="true">
                  <Search size={18} />
                </span>
                <strong>{platformCounts.all === 0 ? "Your inbox is quiet" : "No conversations found"}</strong>
                <p>
                  {platformCounts.all === 0
                    ? "Sign in through Goalbar Browser, then scan a platform."
                    : "Try a different name, phrase, platform, or unread state."}
                </p>
              </div>
            ) : (
              visibleConversations.map((conversation) => (
                <button
                  className="conversation-row conversation-button"
                  data-unread={conversation.unreadCount > 0}
                  data-selected={selected?.id === conversation.id}
                  key={conversation.id}
                  onClick={() => selectConversation(conversation)}
                >
                  <span className="avatar" aria-hidden="true">
                    {conversation.displayName.slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <div className="conversation-copy">
                    <div className="conversation-meta">
                      <strong>{conversation.displayName}</strong>
                      <span>{relativeDate(conversation.updatedAt)}</span>
                    </div>
                    <p>{conversation.preview}</p>
                    <span className="conversation-platform">{titleCase(conversation.platform)}</span>
                  </div>
                  <div className="conversation-signals">
                    {conversation.unreadCount > 0 && <span className="unread-dot" aria-label="New" />}
                    {selected?.id === conversation.id && (
                      <span className="conversation-live-label">Live</span>
                    )}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="inbox-detail-stack">
          {!selected ? (
            <section className="inbox-thread-empty">
              <div className="inbox-thread-empty-mark" aria-hidden="true">
                <Sparkles size={24} />
              </div>
              <p className="eyebrow">Live workspace</p>
              <h2>Choose a conversation</h2>
              <p>Select someone from the queue to open their real, signed-in platform thread here.</p>
              <Badge tone="good">Local session · no silent sends</Badge>
            </section>
          ) : (
            <>
              {selected.remoteUrl && (
                <InboxBrowserPane
                  conversation={selected}
                  onOpenExternally={(url) => openPlatform.mutate(url)}
                />
              )}
              <section className="reply-panel" data-collapsed={!composerOpen}>
                <button
                  type="button"
                  className="inbox-composer-toggle"
                  aria-expanded={composerOpen}
                  onClick={() => setComposerOpen((value) => !value)}
                >
                  <span className="panel-icon">
                    <Sparkles size={15} />
                  </span>
                  <span>
                    <strong>Reply studio</strong>
                    <small>Draft locally · approve exact text · finish on platform</small>
                  </span>
                  {composerOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                </button>
                {composerOpen && (
                  <div className="inbox-composer-body">
                    <div className="inbox-composer-context">
                      <div>
                        <strong>Reply to {selected.displayName}</strong>
                        <span>
                          {titleCase(selected.platform)} · {titleCase(selected.kind)}
                        </span>
                      </div>
                      {selected.remoteUrl && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Open on platform"
                          onClick={() => openPlatform.mutate(selected.remoteUrl!)}
                        >
                          <ArrowUpRight size={16} />
                        </Button>
                      )}
                    </div>
                    {selected.source === "platform_api" && selected.kind === "direct_message" && (
                      <label className="field">
                        <span>Recipient platform ID</span>
                        <Input value={recipientId} onChange={(event) => setRecipientId(event.target.value)} />
                      </label>
                    )}
                    <Textarea
                      rows={3}
                      value={body}
                      onChange={(event) => {
                        setBody(event.target.value)
                        setApprovalId(null)
                        setCopied(false)
                      }}
                      placeholder="Draft a thoughtful reply…"
                    />
                    <div className="reply-actions">
                      {localPreview && (
                        <span className="inbox-no-send-note">
                          <strong>
                            {selected.source === "email_notification"
                              ? selected.contentState === "link_only"
                                ? "Link-only notification"
                                : "Email excerpt"
                              : "Browser preview"}
                          </strong>
                          Open the platform to verify the full conversation. Goalbar will not send
                          automatically.
                        </span>
                      )}
                      <Button variant="secondary" onClick={() => draft.mutate()} disabled={draft.isPending}>
                        {draft.isPending ? "Drafting…" : "Draft with Codex"}
                      </Button>
                      {localPreview ? (
                        approvalId ? (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() => copyApproved.mutate()}
                              disabled={copyApproved.isPending}
                            >
                              <Copy size={14} /> {copied ? "Copied" : "Copy approved text"}
                            </Button>
                            {selected.remoteUrl && (
                              <Button onClick={() => openPlatform.mutate(selected.remoteUrl!)}>
                                <ArrowUpRight size={14} /> Open platform
                              </Button>
                            )}
                          </>
                        ) : (
                          <Button onClick={() => approve.mutate()} disabled={!body || approve.isPending}>
                            <Check size={14} /> Approve exact text
                          </Button>
                        )
                      ) : approvalId ? (
                        <Button onClick={() => send.mutate()} disabled={send.isPending}>
                          {send.isPending ? (
                            "Sending…"
                          ) : (
                            <>
                              <Send size={14} /> Send approved text
                            </>
                          )}
                        </Button>
                      ) : (
                        <Button onClick={() => approve.mutate()} disabled={!body || approve.isPending}>
                          <Check size={14} /> Approve exact text
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {actionError && (
        <div className="inline-error inbox-error-toast">
          <strong>Inbox action could not finish</strong>
          <span>{actionError.message}</span>
        </div>
      )}
    </div>
  )
}
