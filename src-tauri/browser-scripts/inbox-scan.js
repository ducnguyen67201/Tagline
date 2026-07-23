/* global document, getComputedStyle, URL, window */
/* eslint-disable no-control-regex */
;(() => {
  const mode = String(globalThis.__GOALBAR_INBOX_SCAN_MODE__ || "start")
  const platform = String(globalThis.__GOALBAR_INBOX_SCAN_PLATFORM__ || "")
  const scanKey = "__GOALBAR_INBOX_SCAN_STATE__"
  const normalize = (value) =>
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const lines = (node) =>
    String(node?.innerText ?? node?.textContent ?? "")
      .split(/\r?\n/)
      .map(normalize)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
  const canonical = (value) => {
    const candidate = normalize(value)
    if (!candidate) return null
    try {
      const url = new URL(candidate, window.location.href)
      if (url.protocol !== "https:") return null
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return null
    }
  }
  const canonicalProfile = (value) => {
    const candidate = normalize(value)
    if (!candidate) return null
    try {
      const url = new URL(candidate, window.location.href)
      if (platform === "linkedin") {
        const host = url.hostname.toLocaleLowerCase().replace(/^www\./, "")
        const segments = url.pathname.split("/").filter(Boolean)
        if (url.protocol !== "https:" || host !== "linkedin.com" || segments[0]?.toLowerCase() !== "in") {
          return null
        }
        url.pathname = `/${segments.slice(0, 2).join("/")}/`
      } else if (!isProfileUrl(url.toString())) {
        return null
      }
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return null
    }
  }
  const isConversationUrl = (value) => {
    try {
      const url = new URL(value, window.location.href)
      const path = url.pathname.replace(/\/+$/, "")
      if (platform === "x") {
        return (
          (/^\/messages\/[^/]+/.test(path) && !path.includes("/compose")) || /^\/i\/chat\/[^/]+/.test(path)
        )
      }
      if (platform === "linkedin") {
        const segments = path.split("/").filter(Boolean)
        return (
          segments[0]?.toLowerCase() === "messaging" &&
          segments[1]?.toLowerCase() === "thread" &&
          Boolean(segments[2]) &&
          segments[2]?.toLowerCase() !== "undefined" &&
          (segments.length === 3 || (segments.length === 4 && segments[3]?.toLowerCase() === "undefined"))
        )
      }
      if (platform === "reddit") {
        return /^\/message\/messages\/[^/]+/.test(path) || /^\/room\/[^/]+/.test(path)
      }
      return false
    } catch {
      return false
    }
  }
  const isProfileUrl = (value) => {
    try {
      const url = new URL(value, window.location.href)
      const host = url.hostname.toLocaleLowerCase().replace(/^www\./, "")
      const path = url.pathname.replace(/\/+$/, "")
      if (platform === "x") {
        return (
          (host === "x.com" || host === "twitter.com") &&
          /^\/[^/]+$/.test(path) &&
          !/^\/(?:home|messages|explore|notifications|i|search|settings)$/i.test(path)
        )
      }
      if (platform === "linkedin") {
        return host === "linkedin.com" && /^\/in\/[^/]+$/i.test(path)
      }
      if (platform === "reddit") {
        return host === "reddit.com" && /^\/(?:user|u)\/[^/]+$/i.test(path)
      }
      return false
    } catch {
      return false
    }
  }
  const targetUrl =
    platform === "x"
      ? "https://x.com/messages"
      : platform === "linkedin"
        ? "https://www.linkedin.com/messaging/"
        : "https://www.reddit.com/message/inbox"
  const canonicalConversation = (value) => {
    const result = canonical(value)
    if (!result || platform !== "linkedin") return result
    const url = new URL(result)
    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.at(-1)?.toLowerCase() === "undefined") {
      segments.pop()
      url.pathname = `/${segments.join("/")}/`
    }
    return url.toString()
  }
  const pageState = () => {
    const path = window.location.pathname.toLowerCase()
    if (/login|signin|signup|auth/.test(path)) return "login_required"
    if (/challenge|checkpoint|verify/.test(path)) return "verification_required"
    const supported =
      (platform === "x" && (path.startsWith("/messages") || path.startsWith("/i/chat"))) ||
      (platform === "linkedin" && path.startsWith("/messaging")) ||
      (platform === "reddit" &&
        (path.startsWith("/message") || window.location.hostname.startsWith("chat.reddit.com")))
    return supported ? "ready" : "unsupported_page"
  }
  const state = pageState()

  if (mode === "finish") {
    const scanState = globalThis[scanKey]
    if (scanState?.scrollNode?.isConnected) scanState.scrollNode.scrollTop = scanState.startScrollTop
    delete globalThis[scanKey]
    return JSON.stringify({ state, items: [], hasMore: false, targetUrl })
  }
  if (state !== "ready") {
    return JSON.stringify({ state, items: [], hasMore: false, targetUrl })
  }

  const selectors =
    platform === "x"
      ? ['[data-testid="conversation"]', 'a[href^="/messages/"]', 'a[href^="/i/chat/"]']
      : platform === "linkedin"
        ? [
            ".msg-conversation-listitem",
            ".msg-conversations-container__convo-item-link",
            'a[href*="/messaging/thread/"]',
          ]
        : [".Message", '[data-testid*="message"]', 'a[href*="/message/messages/"]', 'a[href*="/room/"]']
  const closestRow = (node) => {
    if (platform === "x") {
      return node.closest?.('[data-testid="conversation"], [role="listitem"], [role="row"], li') || node
    }
    if (platform === "linkedin") {
      return (
        node.closest?.(
          ".msg-conversation-listitem, .msg-conversations-container__convo-item, [role='listitem'], li",
        ) || node
      )
    }
    return node.closest?.(".Message, [data-testid*='message'], [role='listitem'], article, li") || node
  }
  const rows = []
  const seenRows = new Set()
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const row = closestRow(node)
      if (seenRows.has(row)) continue
      const rect = row.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      seenRows.add(row)
      rows.push(row)
    }
  }

  const timePattern =
    /^(?:now|yesterday|\d+\s*(?:s|m|h|d|w|mo|y)|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)$/i
  const nodeText = (node) => normalize(node?.innerText || node?.textContent || "")
  const namedText = (row) => {
    const selector =
      platform === "x"
        ? '[data-testid="User-Name"], [data-testid="UserName"], strong, [dir="auto"]'
        : platform === "linkedin"
          ? ".msg-conversation-listitem__participant-names, h3, strong"
          : "[data-testid*='author'], .author, h3, strong"
    return nodeText(row.querySelector(selector))
  }
  const previewText = (row) => {
    const selector =
      platform === "linkedin"
        ? ".msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet"
        : platform === "reddit"
          ? ".md, [data-testid*='subject'], [data-testid*='message'] p"
          : '[data-testid="conversation"] [dir="auto"]'
    return nodeText(row.querySelector(selector))
  }
  const attributeSummary = (row) =>
    [row, ...Array.from(row.querySelectorAll("[aria-label], [title], [data-testid], [class]")).slice(0, 80)]
      .map((node) =>
        [
          node.getAttribute?.("aria-label"),
          node.getAttribute?.("title"),
          node.getAttribute?.("data-testid"),
          node.getAttribute?.("class"),
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join(" ")
  const findLink = (row) =>
    Array.from(row.matches?.("a[href]") ? [row] : row.querySelectorAll("a[href]")).find((anchor) =>
      isConversationUrl(anchor.href),
    )
  const findProfileLink = (row) =>
    Array.from(row.matches?.("a[href]") ? [row] : row.querySelectorAll("a[href]")).find((anchor) =>
      isProfileUrl(anchor.href),
    )
  const itemFor = (row) => {
    const rowLines = lines(row)
    const link = findLink(row)
    const profileLink = findProfileLink(row)
    const remoteUrl = canonicalConversation(link?.href) || targetUrl
    const profileUrl = canonicalProfile(profileLink?.href)
    const timestampNode = row.querySelector("time")
    const timestamp =
      normalize(timestampNode?.getAttribute("datetime")) ||
      nodeText(timestampNode) ||
      rowLines.find((value) => timePattern.test(value)) ||
      null
    const displayName =
      namedText(row) || rowLines.find((value) => !timePattern.test(value) && !/^you[:：]/i.test(value)) || ""
    const selectorPreview = previewText(row)
    const preview =
      rowLines.find(
        (value) =>
          value !== displayName &&
          value !== timestamp &&
          !timePattern.test(value) &&
          !/^(?:chat|messages?|inbox|all|primary|other)$/i.test(value),
      ) ||
      selectorPreview ||
      "Open this conversation on the platform."
    const stableAttribute = [
      row.getAttribute("data-conversation-id"),
      row.getAttribute("data-thread-id"),
      row.getAttribute("data-item-id"),
      row.getAttribute("aria-controls"),
      row.getAttribute("id"),
    ]
      .map(normalize)
      .find((value) => value && !/^ember\d+$/i.test(value))
    const linkedRemoteId =
      link &&
      (() => {
        try {
          return new URL(remoteUrl).pathname.replace(/^\/+|\/+$/g, "")
        } catch {
          return ""
        }
      })()
    const remoteId = stableAttribute || linkedRemoteId || `fallback:${platform}:${displayName.toLowerCase()}`
    const marker = attributeSummary(row)
    const unread = /(?:^|\W)(?:unread|new-message|new message)(?:\W|$)/i.test(marker)
    const direction = /^you[:：]/i.test(preview) ? "outbound" : "inbound"
    if (!displayName || !remoteId) return null
    return {
      remoteId,
      displayName,
      preview,
      unread,
      remoteUrl,
      profileUrl,
      timestamp,
      direction,
    }
  }
  const scrollableAncestor = (row) => {
    let current = row?.parentElement
    while (current && current !== document.body) {
      const style = getComputedStyle(current)
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 4) {
        return current
      }
      current = current.parentElement
    }
    return null
  }
  let scanState = globalThis[scanKey]
  if (!scanState || mode === "start") {
    const fallbackScrollNode = Array.from(document.querySelectorAll("main *"))
      .filter((node) => node.scrollHeight > node.clientHeight + 4)
      .sort(
        (left, right) => right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
      )[0]
    const scrollNode = scrollableAncestor(rows[0]) || fallbackScrollNode || null
    scanState = {
      scrollNode,
      startScrollTop: scrollNode?.scrollTop || 0,
      bottomPasses: 0,
      profileUrls: Object.create(null),
      attemptedProfiles: Object.create(null),
      pendingProfile: null,
      threadUrls: Object.create(null),
      attemptedThreads: Object.create(null),
      pendingThread: null,
    }
    globalThis[scanKey] = scanState
  }
  const rowItems = rows
    .map((row) => ({ row, item: itemFor(row) }))
    .filter(({ item }) => Boolean(item))
    .slice(0, 100)
  const directUrlCounts = rowItems.reduce((counts, { item }) => {
    if (item.remoteUrl === targetUrl || !isConversationUrl(item.remoteUrl)) return counts
    counts[item.remoteUrl] = (counts[item.remoteUrl] || 0) + 1
    return counts
  }, Object.create(null))
  for (const { item } of rowItems) {
    if (
      item.remoteUrl !== targetUrl &&
      isConversationUrl(item.remoteUrl) &&
      directUrlCounts[item.remoteUrl] === 1
    ) {
      scanState.threadUrls[item.remoteId] = item.remoteUrl
      scanState.attemptedThreads[item.remoteId] = true
    }
    if (!item.profileUrl) continue
    scanState.profileUrls[item.remoteId] = item.profileUrl
    scanState.attemptedProfiles[item.remoteId] = true
  }
  const linkedInThreadProfile = () => {
    const threadProfileLink = document.querySelector(
      'a.msg-thread__link-to-profile[href*="/in/"], .msg-thread__link-to-profile a[href*="/in/"]',
    )
    return canonicalProfile(threadProfileLink?.href)
  }
  const linkedInProfileFor = (displayName) => {
    const threadProfileUrl = linkedInThreadProfile()
    if (threadProfileUrl) return threadProfileUrl

    const targetName = normalize(displayName).toLocaleLowerCase()
    if (!targetName) return null
    return Array.from(document.querySelectorAll('a[href*="/in/"]'))
      .filter((anchor) => {
        const rect = anchor.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || !isProfileUrl(anchor.href)) return false
        const label = normalize(
          [
            anchor.textContent,
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.querySelector("img")?.getAttribute("alt"),
          ]
            .filter(Boolean)
            .join(" "),
        ).toLocaleLowerCase()
        return label.includes(targetName)
      })
      .map((anchor) => canonicalProfile(anchor.href))
      .find(Boolean)
  }
  const linkedInThreadMatches = (pending) => {
    const expectedProfile = pending.profileUrl || scanState.profileUrls[pending.remoteId]
    const threadProfile = linkedInThreadProfile()
    if (expectedProfile && threadProfile) return expectedProfile === threadProfile

    const targetName = normalize(pending.displayName).toLocaleLowerCase()
    if (!targetName) return false
    const thread = document.querySelector(
      ".msg-thread, .msg-s-message-list-container, [data-view-name='message-thread']",
    )
    return normalize(thread?.innerText || thread?.textContent)
      .toLocaleLowerCase()
      .includes(targetName)
  }
  const clickLinkedInRow = (row) => {
    const clickable =
      (row.matches?.("a, button") && row) ||
      row.querySelector(
        ".msg-conversations-container__convo-item-link, a[href*='/messaging/thread/'], button",
      ) ||
      row
    if (
      clickable.tagName === "A" &&
      clickable.pathname
        .split("/")
        .filter(Boolean)
        .some((segment) => segment.toLocaleLowerCase() === "undefined")
    ) {
      clickable.addEventListener("click", (event) => event.preventDefault(), {
        capture: true,
        once: true,
      })
    }
    clickable.click()
  }
  if (platform === "linkedin" && scanState.pendingProfile) {
    const pending = scanState.pendingProfile
    const profileUrl = linkedInProfileFor(pending.displayName)
    if (profileUrl) scanState.profileUrls[pending.remoteId] = profileUrl
    scanState.pendingProfile = null
  }
  if (platform === "linkedin") {
    if (scanState.pendingThread) {
      const pending = scanState.pendingThread
      const threadMatches = linkedInThreadMatches(pending)
      const observedProfile = linkedInThreadProfile()
      if (threadMatches && observedProfile) {
        scanState.profileUrls[pending.remoteId] = observedProfile
        scanState.attemptedProfiles[pending.remoteId] = true
      }
      const currentLocation = new URL(
        `${window.location.pathname}${window.location.search}`,
        targetUrl,
      ).toString()
      const currentThreadUrl = isConversationUrl(currentLocation)
        ? canonicalConversation(currentLocation)
        : null
      if (currentThreadUrl && threadMatches) {
        scanState.threadUrls[pending.remoteId] = currentThreadUrl
        scanState.attemptedThreads[pending.remoteId] = true
        const profileUrl = linkedInThreadProfile()
        if (profileUrl) {
          scanState.profileUrls[pending.remoteId] = profileUrl
          scanState.attemptedProfiles[pending.remoteId] = true
        }
        scanState.pendingThread = null
      } else if (pending.attempts >= 3) {
        scanState.attemptedThreads[pending.remoteId] = true
        scanState.pendingThread = null
      } else {
        const pendingRow = rowItems.find(({ item }) => item.remoteId === pending.remoteId)
        if (pendingRow) {
          pending.attempts += 1
          clickLinkedInRow(pendingRow.row)
          const items = rowItems.map(({ item }) => ({
            ...item,
            remoteUrl: scanState.threadUrls[item.remoteId] || targetUrl,
            profileUrl: scanState.profileUrls[item.remoteId] || item.profileUrl,
          }))
          return JSON.stringify({ state, items, hasMore: true, madeProgress: true, targetUrl })
        }
        scanState.attemptedThreads[pending.remoteId] = true
        scanState.pendingThread = null
      }
    }
    const unresolvedThread = rowItems.find(
      ({ item }) => !scanState.attemptedThreads[item.remoteId] && !scanState.threadUrls[item.remoteId],
    )
    if (unresolvedThread) {
      scanState.pendingThread = {
        remoteId: unresolvedThread.item.remoteId,
        displayName: unresolvedThread.item.displayName,
        profileUrl: unresolvedThread.item.profileUrl,
        attempts: 0,
      }
      clickLinkedInRow(unresolvedThread.row)
      const items = rowItems.map(({ item }) => ({
        ...item,
        remoteUrl: scanState.threadUrls[item.remoteId] || targetUrl,
        profileUrl: scanState.profileUrls[item.remoteId] || item.profileUrl,
      }))
      return JSON.stringify({ state, items, hasMore: true, madeProgress: true, targetUrl })
    }
  }
  const items = rowItems.map(({ item }) => ({
    ...item,
    remoteUrl: scanState.threadUrls[item.remoteId] || item.remoteUrl,
    profileUrl: scanState.profileUrls[item.remoteId] || item.profileUrl,
  }))
  if (platform === "linkedin") {
    const unresolved = rowItems.find(
      ({ item }) => !scanState.attemptedProfiles[item.remoteId] && !scanState.profileUrls[item.remoteId],
    )
    if (unresolved) {
      scanState.attemptedProfiles[unresolved.item.remoteId] = true
      scanState.pendingProfile = {
        remoteId: unresolved.item.remoteId,
        displayName: unresolved.item.displayName,
      }
      clickLinkedInRow(unresolved.row)
      return JSON.stringify({ state, items, hasMore: true, madeProgress: true, targetUrl })
    }
  }
  const scrollNode = scanState.scrollNode
  const canScroll = Boolean(
    scrollNode &&
    scrollNode.isConnected &&
    scrollNode.scrollTop + scrollNode.clientHeight < scrollNode.scrollHeight - 4,
  )
  scanState.bottomPasses = canScroll ? 0 : scanState.bottomPasses + 1
  const hasMore = canScroll || Boolean(scrollNode?.isConnected && scanState.bottomPasses < 3)
  if (canScroll) {
    scrollNode.scrollTop = Math.min(
      scrollNode.scrollTop + Math.max(200, Math.floor(scrollNode.clientHeight * 0.82)),
      scrollNode.scrollHeight,
    )
  }
  return JSON.stringify({ state, items, hasMore, targetUrl })
})()
