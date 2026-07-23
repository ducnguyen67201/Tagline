# Browser inbox scans

Goalbar can import conversation-list previews from X, Reddit, and LinkedIn without platform developer applications or paid API calls.

## Setup

1. Open the platform in Goalbar **Browser**.
2. Sign in directly on the platform website. The website session remains in the local webview profile.
3. Open **Inbox** and choose **Scan X**, **Scan Reddit**, or **Scan LinkedIn**.
4. If Goalbar reports that sign-in or verification is required, finish that step visibly in **Browser**, then scan again.
5. Select an imported conversation to open its real platform thread in the live browser pane beside the inbox.

## Scan behavior

- The first successful scan for a platform scrolls through its virtualized conversation list until the oldest row exposed by the website is reached.
- Later scans are incremental: they collect new and changed rows, then stop after reaching conversations already stored locally.
- Full scans remain bounded to 500 mounted batches and 10,000 normalized rows; incremental scans are bounded to 50 batches and 1,000 rows. If a website stalls or a safety ceiling is reached, Goalbar reports a partial scan and keeps the rows already collected.
- Goalbar may navigate an existing local platform tab to its messages page. It never creates a platform account, enters credentials, or bypasses a login or verification challenge.
- A scan stores the platform, stable row identifier where available, display name, preview, unread marker, timestamp, and same-platform conversation link.
- Repeated scans update existing rows instead of creating duplicates.
- Placeholder LinkedIn routes such as links ending in `/undefined/` are rejected. When a conversation row does not expose a trustworthy URL, the user-triggered scan selects that row and records the resulting deep link only after the visible thread identity matches the row. If it cannot confirm the match, Goalbar keeps the signed-in messaging inbox URL instead of presenting a false deep link.
- Conversation-list HTML is undocumented and can change. A completed initial scan means Goalbar reached the oldest conversation row that the website exposed to the local webview; it does not guarantee complete server-side history or import every message inside each thread.

For a complete account record, use the platform's official archive import. Browser inbox scanning is the live conversation-index path; official archives remain the completeness path for historical message content.

## Trust and write boundary

Browser previews are incomplete and untrusted. Goalbar can use a preview to draft and record approval for exact text, but it cannot send from a browser-scanned row. Selecting a row reuses the signed-in local platform tab in the right-side pane so the user can verify the real context, copy the approved text, and send manually on the platform.

Cookies, passwords, website tokens, raw HTML, and arbitrary page JavaScript are not stored or passed to Codex or Claude.

Automatic background scans are intentionally not enabled. A future background mode must preserve the same local-session, bounded-read, typed-pause, and no-send boundaries.
