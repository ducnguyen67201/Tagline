import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { responsiveBrowserPanelWidth } from "./browser-layout"
import { BrowserPage } from "./BrowserPage"

function renderBrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BrowserPage />
    </QueryClientProvider>,
  )
}

describe("BrowserPage preview mode", () => {
  it("keeps both workbench panes usable as the window resizes", () => {
    expect(responsiveBrowserPanelWidth(480, 892)).toBe(464)
    expect(responsiveBrowserPanelWidth(340, 1400)).toBe(340)
    expect(responsiveBrowserPanelWidth(100, 1400)).toBe(280)
  })

  it("opens on a blank platform chooser", () => {
    renderBrowser()
    expect(screen.getByRole("heading", { name: "Chat with the browser beside you." })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Founder chat" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Where do you want to research?" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /open x/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /open linkedin/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /open reddit/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Browser Use for this chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.queryByRole("region", { name: "Local agent terminals" })).not.toBeInTheDocument()
    expect(screen.queryByText("Research add-on requested")).not.toBeInTheDocument()
  })

  it("lets persistent Codex chat call Browser Use against the open supported tab", async () => {
    const user = userEvent.setup()
    renderBrowser()
    await user.click(screen.getByRole("button", { name: /open x/i }))
    await user.type(
      screen.getByRole("textbox", { name: "Chat message" }),
      "Find me good 5 posts for ICP pain signals",
    )
    await user.click(screen.getByRole("button", { name: "Send message" }))
    expect(await screen.findByRole("region", { name: "Codex Browser Use activity" })).toBeInTheDocument()
    expect(await screen.findByText("Browser Use complete")).toBeInTheDocument()
    expect(screen.getByText("Called directly by the persistent Codex chat")).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /approve this objective/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run approved research" })).not.toBeInTheDocument()
  })

  it("explains that Browser Use needs an open supported tab", async () => {
    const user = userEvent.setup()
    renderBrowser()
    await user.type(screen.getByRole("textbox", { name: "Chat message" }), "Analyze this feed")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    expect(
      await screen.findByText(
        "Open X, LinkedIn, or Reddit beside this chat so Browser Use has a page to inspect.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Codex Browser Use activity" })).not.toBeInTheDocument()
  })

  it("keeps strategy-only questions in chat instead of forcing Browser Use", async () => {
    const user = userEvent.setup()
    renderBrowser()
    await user.type(screen.getByRole("textbox", { name: "Chat message" }), "Help me sharpen my positioning")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    expect(
      await screen.findByText(
        "I can help shape that. Give me the audience, the outcome you want, and what you already believe to be true.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Codex Browser Use activity" })).not.toBeInTheDocument()
  })

  it("starts a fresh persistent Codex chat from the header", async () => {
    const user = userEvent.setup()
    renderBrowser()
    await user.type(screen.getByRole("textbox", { name: "Chat message" }), "Help me sharpen my positioning")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    expect(await screen.findByText(/give me the audience/i)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "New Codex chat" }))
    await waitFor(() => expect(screen.queryByText(/give me the audience/i)).not.toBeInTheDocument())
    expect(screen.getByText(/I’m your founder chat/i)).toBeInTheDocument()
  })

  it("keeps the address visible and normalizes an HTTPS navigation", async () => {
    const user = userEvent.setup()
    renderBrowser()
    const address = screen.getByRole("textbox", { name: "Browser address" })
    await user.clear(address)
    await user.type(address, "reddit.com/r/startups{Enter}")
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveValue(
        "https://reddit.com/r/startups",
      ),
    )
  })

  it("opens the platform chooser when a new tab is requested", async () => {
    const user = userEvent.setup()
    renderBrowser()
    await user.click(screen.getByRole("button", { name: /open linkedin/i }))
    expect(screen.queryByRole("heading", { name: "Where do you want to research?" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "New browser tab" }))

    expect(screen.getByRole("heading", { name: "Where do you want to research?" })).toBeInTheDocument()
  })
})
