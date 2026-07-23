import { runInThisContext } from "node:vm"

import { beforeEach, describe, expect, it, vi } from "vitest"

import inboxScanScript from "../../../src-tauri/browser-scripts/inbox-scan.js?raw"

type ScanBatch = {
  state: string
  items: Array<{
    remoteId: string
    displayName: string
    preview: string
    unread: boolean
    remoteUrl: string
    direction: string
  }>
}

function scan(platform: "x" | "reddit" | "linkedin", path: string): ScanBatch {
  window.history.replaceState({}, "", path)
  Object.assign(globalThis, {
    __GOALBAR_INBOX_SCAN_PLATFORM__: platform,
    __GOALBAR_INBOX_SCAN_MODE__: "start",
  })
  const executable = inboxScanScript.replace(";(() =>", "(() =>")
  return JSON.parse(runInThisContext(executable) as string) as ScanBatch
}

function setInnerText(selector: string, value: string) {
  Object.defineProperty(document.querySelector(selector), "innerText", {
    configurable: true,
    value,
  })
}

describe("browser inbox extraction script", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 420,
      height: 72,
      top: 0,
      right: 420,
      bottom: 72,
      left: 0,
      toJSON: () => ({}),
    })
  })

  it("extracts X conversation links, previews, direction, and unread state", () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="conversation" aria-label="Unread conversation">
          <a href="https://x.com/messages/123">
            <strong>Ari</strong>
            <span>You: Thanks man</span>
            <time datetime="2026-07-17T18:00:00Z">6d</time>
          </a>
        </div>
      </main>
    `
    setInnerText('[data-testid="conversation"]', "Ari\nYou: Thanks man\n6d")

    const result = scan("x", "/messages")

    expect(result.state).toBe("ready")
    expect(result.items).toEqual([
      expect.objectContaining({
        remoteId: "messages/123",
        displayName: "Ari",
        preview: "You: Thanks man",
        unread: true,
        remoteUrl: "https://x.com/messages/123",
        direction: "outbound",
      }),
    ])
  })

  it.each([
    {
      platform: "linkedin" as const,
      path: "/messaging/",
      row: `<li class="msg-conversation-listitem">
        <a href="https://www.linkedin.com/messaging/thread/abc/">
          <strong>Mina</strong><span>Can we compare notes?</span>
        </a>
      </li>`,
      selector: ".msg-conversation-listitem",
      text: "Mina\nCan we compare notes?\n2h",
      remoteId: "messaging/thread/abc",
    },
    {
      platform: "reddit" as const,
      path: "/message/inbox",
      row: `<article class="Message">
        <a href="https://www.reddit.com/message/messages/xyz">
          <strong>u/founder</strong><span>Quick question</span>
        </a>
      </article>`,
      selector: ".Message",
      text: "u/founder\nQuick question\n1d",
      remoteId: "message/messages/xyz",
    },
  ])("extracts $platform conversation rows", ({ platform, path, row, selector, text, remoteId }) => {
    document.body.innerHTML = `<main>${row}</main>`
    setInnerText(selector, text)

    const result = scan(platform, path)

    expect(result.state).toBe("ready")
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        remoteId,
        unread: false,
        direction: "inbound",
      }),
    )
  })

  it("rejects LinkedIn placeholder thread URLs and uses stable per-person identities", () => {
    document.body.innerHTML = `
      <main>
        <li id="ember47" class="msg-conversation-listitem">
          <a href="https://www.linkedin.com/messaging/thread/2-mailbox/undefined/">
            <strong>Ross McIntyre</strong><span>Status is reachable</span>
          </a>
        </li>
        <li id="ember55" class="msg-conversation-listitem">
          <a href="https://www.linkedin.com/messaging/thread/2-mailbox/undefined/">
            <strong>Sashank Tadepalli</strong><span>Status is reachable</span>
          </a>
        </li>
      </main>
    `
    setInnerText("#ember47", "Ross McIntyre\nStatus is reachable\nNow")
    setInnerText("#ember55", "Sashank Tadepalli\nStatus is reachable\nNow")

    const result = scan("linkedin", "/messaging/")

    expect(result.items).toEqual([
      expect.objectContaining({
        remoteId: "fallback:linkedin:ross mcintyre",
        remoteUrl: "https://www.linkedin.com/messaging/",
      }),
      expect.objectContaining({
        remoteId: "fallback:linkedin:sashank tadepalli",
        remoteUrl: "https://www.linkedin.com/messaging/",
      }),
    ])
  })
})
