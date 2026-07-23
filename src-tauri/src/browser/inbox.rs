use std::collections::HashMap;

use serde::Deserialize;
use tauri::AppHandle;
use uuid::Uuid;

use crate::browser::BrowserManager;
use crate::browser::extraction::{evaluate, parse_evaluation};
use crate::browser::policy::{browser_url, platform_from_url, strip_tracking};
use crate::domain::Platform;
use crate::error::{AppError, AppResult};
use crate::validation::payload_hash;

const INBOX_SCAN_SCRIPT: &str = include_str!("../../browser-scripts/inbox-scan.js");
const MAX_SCAN_BATCHES: usize = 5;
const MAX_ITEMS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserInboxPageState {
    Ready,
    LoginRequired,
    VerificationRequired,
    UnsupportedPage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserInboxDirection {
    Inbound,
    Outbound,
}

impl BrowserInboxDirection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserInboxItem {
    pub remote_id: String,
    pub display_name: String,
    pub preview: String,
    pub unread: bool,
    pub remote_url: String,
    pub timestamp: Option<String>,
    pub direction: BrowserInboxDirection,
}

#[derive(Debug, Clone)]
pub struct BrowserInboxPageScan {
    pub state: BrowserInboxPageState,
    pub items: Vec<BrowserInboxItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBatch {
    state: BrowserInboxPageState,
    items: Vec<RawItem>,
    has_more: bool,
    target_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawItem {
    remote_id: String,
    display_name: String,
    preview: String,
    unread: bool,
    remote_url: String,
    timestamp: Option<String>,
    direction: BrowserInboxDirection,
}

pub async fn scan(
    app: &AppHandle,
    manager: &BrowserManager,
    tab_id: Uuid,
    platform: Platform,
) -> AppResult<BrowserInboxPageScan> {
    let outcome = scan_batches(app, manager, tab_id, platform).await;
    let _ = evaluate_mode(app, manager, tab_id, platform, "finish").await;
    outcome
}

async fn scan_batches(
    app: &AppHandle,
    manager: &BrowserManager,
    tab_id: Uuid,
    platform: Platform,
) -> AppResult<BrowserInboxPageScan> {
    let mut items = HashMap::new();
    let mut state = BrowserInboxPageState::Ready;
    for index in 0..MAX_SCAN_BATCHES {
        let mode = if index == 0 { "start" } else { "next" };
        let batch = evaluate_mode(app, manager, tab_id, platform, mode).await?;
        state = batch.state;
        if state != BrowserInboxPageState::Ready {
            break;
        }
        for raw in batch.items {
            if let Some(item) = normalize_item(raw, platform) {
                items.insert(item.remote_id.clone(), item);
            }
            if items.len() >= MAX_ITEMS {
                break;
            }
        }
        if items.len() >= MAX_ITEMS || !batch.has_more {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
    let mut items = items.into_values().collect::<Vec<_>>();
    items.sort_by(|left, right| left.remote_id.cmp(&right.remote_id));
    Ok(BrowserInboxPageScan { state, items })
}

async fn evaluate_mode(
    app: &AppHandle,
    manager: &BrowserManager,
    tab_id: Uuid,
    platform: Platform,
    mode: &str,
) -> AppResult<RawBatch> {
    let platform_value = serde_json::to_string(platform.as_str())?;
    let mode = serde_json::to_string(mode)?;
    let script = format!(
        "globalThis.__GOALBAR_INBOX_SCAN_PLATFORM__ = {platform_value};\
         globalThis.__GOALBAR_INBOX_SCAN_MODE__ = {mode};\
         {INBOX_SCAN_SCRIPT}"
    );
    let raw = evaluate(app, manager, tab_id, &script).await?;
    let batch: RawBatch = parse_evaluation(&raw)?;
    let expected_target = browser_url(&batch.target_url)?;
    if platform_from_url(&expected_target) != Some(platform) {
        return Err(AppError::Validation(
            "browser inbox scanner returned a cross-platform target".to_owned(),
        ));
    }
    Ok(batch)
}

fn normalize_item(raw: RawItem, platform: Platform) -> Option<BrowserInboxItem> {
    let display_name = bounded(&raw.display_name, 120);
    if display_name.is_empty() {
        return None;
    }
    let remote_url = strip_tracking(browser_url(&raw.remote_url).ok()?);
    if platform_from_url(&remote_url) != Some(platform) {
        return None;
    }
    let mut remote_id = bounded(&raw.remote_id, 500);
    if remote_id.is_empty() {
        remote_id = payload_hash(&format!(
            "{}\n{}\n{}",
            platform.as_str(),
            display_name,
            remote_url
        ));
    }
    let preview = bounded(&raw.preview, 600);
    Some(BrowserInboxItem {
        remote_id,
        display_name,
        preview: if preview.is_empty() {
            "Open this conversation on the platform.".to_owned()
        } else {
            preview
        },
        unread: raw.unread,
        remote_url: remote_url.to_string(),
        timestamp: raw
            .timestamp
            .map(|value| bounded(&value, 80))
            .filter(|value| !value.is_empty()),
        direction: raw.direction,
    })
}

fn bounded(value: &str, maximum: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(maximum)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{BrowserInboxDirection, RawItem, normalize_item};
    use crate::domain::Platform;

    #[test]
    fn browser_inbox_items_are_bounded_and_same_platform() {
        let valid = normalize_item(
            RawItem {
                remote_id: "messages/123".to_owned(),
                display_name: "Ari".to_owned(),
                preview: "A useful note".to_owned(),
                unread: true,
                remote_url: "https://x.com/messages/123?tracking=1".to_owned(),
                timestamp: Some("6d".to_owned()),
                direction: BrowserInboxDirection::Inbound,
            },
            Platform::X,
        )
        .expect("valid item");
        assert_eq!(valid.remote_url, "https://x.com/messages/123");
        assert!(valid.unread);
        assert_eq!(valid.direction, BrowserInboxDirection::Inbound);

        assert!(
            normalize_item(
                RawItem {
                    remote_url: "https://reddit.com/message/messages/1".to_owned(),
                    ..RawItem {
                        remote_id: "messages/1".to_owned(),
                        display_name: "Wrong host".to_owned(),
                        preview: "No".to_owned(),
                        unread: false,
                        remote_url: String::new(),
                        timestamp: None,
                        direction: BrowserInboxDirection::Inbound,
                    }
                },
                Platform::X,
            )
            .is_none()
        );
    }

    #[test]
    fn linkedin_placeholder_thread_urls_fall_back_to_the_inbox() {
        let item = normalize_item(
            RawItem {
                remote_id: "fallback:linkedin:ross mcintyre".to_owned(),
                display_name: "Ross McIntyre".to_owned(),
                preview: "Status is reachable".to_owned(),
                unread: false,
                remote_url:
                    "https://www.linkedin.com/messaging/thread/2-mailbox/undefined/".to_owned(),
                timestamp: None,
                direction: BrowserInboxDirection::Inbound,
            },
            Platform::Linkedin,
        )
        .expect("the row remains useful without a false deep link");

        assert_eq!(item.remote_url, "https://www.linkedin.com/messaging/");
    }
}
