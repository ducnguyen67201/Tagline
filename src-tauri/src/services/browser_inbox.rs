use std::collections::HashSet;

use chrono::{DateTime, Datelike as _, Duration, NaiveDate, Utc};
use sqlx::{Sqlite, Transaction};
use tauri::AppHandle;
use uuid::Uuid;

use crate::browser::BrowserManager;
use crate::browser::inbox::{
    self, BrowserInboxItem, BrowserInboxPageScan, BrowserInboxPageState, BrowserInboxScanMode,
};
use crate::browser::policy::{browser_url, page_kind, strip_tracking};
use crate::domain::Platform;
use crate::domain::browser::{BrowserLoadState, BrowserPageKind};
use crate::domain::relationship::{BrowserInboxScanResult, BrowserInboxScanStatus};
use crate::error::{AppError, AppResult};

const LOCAL_BROWSER_CLIENT_ID: &str = "goalbar-browser-inbox";
const LOCAL_BROWSER_REMOTE_ACCOUNT_ID: &str = "__goalbar_browser_inbox__";
const LOCAL_CAPABILITIES_JSON: &str = r#"{"authenticate":"unsupported","publish":"unsupported","readOwnContent":"unsupported","metrics":"unsupported","reply":"unsupported","directMessages":"unsupported","detail":"Browser inbox scans are local previews. Open the platform to verify and send."}"#;

#[derive(Debug, Clone)]
pub struct BrowserInboxService {
    browser: BrowserManager,
    pool: sqlx::SqlitePool,
}

impl BrowserInboxService {
    pub fn new(browser: BrowserManager, pool: sqlx::SqlitePool) -> Self {
        Self { browser, pool }
    }

    pub async fn scan(
        &self,
        app: &AppHandle,
        platform: Platform,
    ) -> AppResult<BrowserInboxScanResult> {
        let target_url = target_url(platform);
        let Some(tab) = self.platform_tab(platform) else {
            return self
                .status_result(
                    platform,
                    BrowserInboxScanStatus::NeedsBrowser,
                    0,
                    0,
                    0,
                    format!(
                        "Open {} in Goalbar Browser and sign in before scanning.",
                        platform_name(platform)
                    ),
                )
                .await;
        };

        let current = strip_tracking(browser_url(&tab.current_url)?);
        let target = strip_tracking(browser_url(target_url)?);
        if current != target {
            self.browser.navigate(app, tab.id, target_url)?;
        }
        wait_for_load(&self.browser, tab.id).await?;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;

        let loaded = self.browser.tab(tab.id)?;
        match page_kind(&browser_url(&loaded.current_url)?) {
            BrowserPageKind::Login => {
                return self
                    .status_result(
                        platform,
                        BrowserInboxScanStatus::LoginRequired,
                        0,
                        0,
                        0,
                        format!(
                            "Sign in to {} in Goalbar Browser, then scan again.",
                            platform_name(platform)
                        ),
                    )
                    .await;
            }
            BrowserPageKind::Challenge => {
                return self
                    .status_result(
                        platform,
                        BrowserInboxScanStatus::VerificationRequired,
                        0,
                        0,
                        0,
                        format!(
                            "Finish the {} verification step in Goalbar Browser, then scan again.",
                            platform_name(platform)
                        ),
                    )
                    .await;
            }
            _ => {}
        }

        let scan_mode = self.scan_mode(platform).await?;
        let known_remote_ids = if scan_mode == BrowserInboxScanMode::Incremental {
            self.known_remote_ids(platform).await?
        } else {
            HashSet::new()
        };
        let mut page_scan = inbox::scan(
            app,
            &self.browser,
            tab.id,
            platform,
            scan_mode,
            known_remote_ids.clone(),
        )
        .await?;
        for _ in 0..2 {
            if page_scan.state != BrowserInboxPageState::Ready || !page_scan.items.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            page_scan = inbox::scan(
                app,
                &self.browser,
                tab.id,
                platform,
                scan_mode,
                known_remote_ids.clone(),
            )
            .await?;
        }
        match page_scan.state {
            BrowserInboxPageState::Ready => self.ingest(platform, page_scan).await,
            BrowserInboxPageState::LoginRequired => {
                self.status_result(
                    platform,
                    BrowserInboxScanStatus::LoginRequired,
                    0,
                    0,
                    0,
                    format!(
                        "Sign in to {} in Goalbar Browser, then scan again.",
                        platform_name(platform)
                    ),
                )
                .await
            }
            BrowserInboxPageState::VerificationRequired => {
                self.status_result(
                    platform,
                    BrowserInboxScanStatus::VerificationRequired,
                    0,
                    0,
                    0,
                    format!(
                        "Finish the {} verification step in Goalbar Browser, then scan again.",
                        platform_name(platform)
                    ),
                )
                .await
            }
            BrowserInboxPageState::UnsupportedPage => {
                self.status_result(
                    platform,
                    BrowserInboxScanStatus::UnsupportedPage,
                    0,
                    0,
                    0,
                    format!(
                        "{} did not expose a supported conversation list. Open its inbox visibly and try again.",
                        platform_name(platform)
                    ),
                )
                .await
            }
        }
    }

    fn platform_tab(&self, platform: Platform) -> Option<crate::domain::browser::BrowserTab> {
        let tabs = self.browser.tabs();
        tabs.iter()
            .find(|tab| {
                tab.platform == Some(platform)
                    && browser_url(&tab.current_url)
                        .map(|url| page_kind(&url) == BrowserPageKind::Messages)
                        .unwrap_or(false)
            })
            .cloned()
            .or_else(|| {
                tabs.into_iter()
                    .rev()
                    .find(|tab| tab.platform == Some(platform))
            })
    }

    async fn scan_mode(&self, platform: Platform) -> AppResult<BrowserInboxScanMode> {
        let completed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM browser_inbox_scan_state WHERE platform = ? AND status = 'completed')",
        )
        .bind(platform.as_str())
        .fetch_one(&self.pool)
        .await?;
        let linkedin_upgrade_needed = if platform == Platform::Linkedin {
            let profile_upgrade_needed = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM browser_inbox_ingestions WHERE platform = 'linkedin')
                    AND NOT EXISTS(
                        SELECT 1 FROM browser_inbox_ingestions
                        WHERE platform = 'linkedin' AND profile_url IS NOT NULL
                    )",
            )
            .fetch_one(&self.pool)
            .await?;
            let thread_url_upgrade_needed = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1 FROM browser_inbox_ingestions
                    WHERE platform = 'linkedin'
                      AND (
                        LOWER(remote_url) = 'https://www.linkedin.com/messaging/'
                        OR LOWER(remote_url) LIKE '%/undefined%'
                      )
                )
                OR EXISTS(
                    SELECT 1
                    FROM browser_inbox_ingestions
                    WHERE platform = 'linkedin'
                    GROUP BY LOWER(remote_url)
                    HAVING COUNT(DISTINCT remote_id) > 1
                )",
            )
            .fetch_one(&self.pool)
            .await?;
            profile_upgrade_needed || thread_url_upgrade_needed
        } else {
            false
        };
        Ok(if completed && !linkedin_upgrade_needed {
            BrowserInboxScanMode::Incremental
        } else {
            BrowserInboxScanMode::Initial
        })
    }

    async fn known_remote_ids(&self, platform: Platform) -> AppResult<HashSet<String>> {
        let remote_ids =
            sqlx::query_scalar("SELECT remote_id FROM browser_inbox_ingestions WHERE platform = ?")
                .bind(platform.as_str())
                .fetch_all(&self.pool)
                .await?;
        Ok(remote_ids.into_iter().collect())
    }

    async fn ingest(
        &self,
        platform: Platform,
        scan: BrowserInboxPageScan,
    ) -> AppResult<BrowserInboxScanResult> {
        let scanned = scan.items.len() as u32;
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let mut imported = 0_u32;
        let mut updated = 0_u32;
        let mut transaction = self.pool.begin().await?;
        ensure_local_account(&mut transaction, platform).await?;
        for (index, item) in scan.items.iter().enumerate() {
            let existing = find_existing_ingestion(&mut transaction, platform, item).await?;
            let conversation_id = if let Some((conversation_id, previous_remote_id)) = existing {
                update_conversation(
                    &mut transaction,
                    platform,
                    &conversation_id,
                    item,
                    observed_at(item.timestamp.as_deref(), now, index),
                    &now_text,
                )
                .await?;
                if previous_remote_id != item.remote_id {
                    sqlx::query(
                        "UPDATE browser_inbox_ingestions SET remote_id = ? WHERE platform = ? AND remote_id = ?",
                    )
                    .bind(&item.remote_id)
                    .bind(platform.as_str())
                    .bind(previous_remote_id)
                    .execute(&mut *transaction)
                    .await?;
                }
                updated += 1;
                conversation_id
            } else {
                let conversation_id = Uuid::new_v4().to_string();
                insert_conversation(
                    &mut transaction,
                    platform,
                    &conversation_id,
                    item,
                    observed_at(item.timestamp.as_deref(), now, index),
                    &now_text,
                )
                .await?;
                imported += 1;
                conversation_id
            };
            sqlx::query("INSERT INTO browser_inbox_ingestions (platform, remote_id, conversation_id, remote_url, profile_url, first_seen_at, last_seen_at, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, remote_id) DO UPDATE SET remote_url = excluded.remote_url, profile_url = COALESCE(excluded.profile_url, browser_inbox_ingestions.profile_url), last_seen_at = excluded.last_seen_at, last_scanned_at = excluded.last_scanned_at")
                .bind(platform.as_str())
                .bind(&item.remote_id)
                .bind(conversation_id)
                .bind(&item.remote_url)
                .bind(item.profile_url.as_deref())
                .bind(&now_text)
                .bind(&now_text)
                .bind(&now_text)
                .execute(&mut *transaction)
                .await?;
        }
        let status = if scan.stop.is_partial() {
            BrowserInboxScanStatus::Partial
        } else {
            BrowserInboxScanStatus::Completed
        };
        record_state(&mut transaction, platform, status, scanned, &now_text).await?;
        transaction.commit().await?;
        let message = if scanned == 0 {
            format!(
                "No supported {} conversation rows were visible. Confirm the inbox is open and fully loaded.",
                platform_name(platform)
            )
        } else if status == BrowserInboxScanStatus::Partial {
            format!(
                "{} stopped loading older rows. Scan again to continue.",
                platform_name(platform)
            )
        } else if scan.mode == BrowserInboxScanMode::Initial {
            format!(
                "Initial scan reached the oldest available {} conversation.",
                platform_name(platform)
            )
        } else {
            format!(
                "Checked new and changed {} conversations.",
                platform_name(platform)
            )
        };
        Ok(BrowserInboxScanResult {
            platform,
            status,
            scanned,
            imported,
            updated,
            last_scanned_at: now_text,
            message,
            target_url: target_url(platform).to_owned(),
        })
    }

    async fn status_result(
        &self,
        platform: Platform,
        status: BrowserInboxScanStatus,
        scanned: u32,
        imported: u32,
        updated: u32,
        message: String,
    ) -> AppResult<BrowserInboxScanResult> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        record_state(&mut transaction, platform, status, scanned, &now).await?;
        transaction.commit().await?;
        Ok(BrowserInboxScanResult {
            platform,
            status,
            scanned,
            imported,
            updated,
            last_scanned_at: now,
            message,
            target_url: target_url(platform).to_owned(),
        })
    }
}

async fn find_existing_ingestion(
    transaction: &mut Transaction<'_, Sqlite>,
    platform: Platform,
    item: &BrowserInboxItem,
) -> AppResult<Option<(String, String)>> {
    let exact: Option<(String, String)> = sqlx::query_as(
        "SELECT conversation_id, remote_id FROM browser_inbox_ingestions WHERE platform = ? AND remote_id = ?",
    )
    .bind(platform.as_str())
    .bind(&item.remote_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if exact.is_some() {
        return Ok(exact);
    }

    if platform == Platform::Linkedin {
        return sqlx::query_as(
            "SELECT b.conversation_id, b.remote_id
             FROM browser_inbox_ingestions b
             JOIN conversations c ON c.id = b.conversation_id
             WHERE b.platform = ?
               AND (
                 LOWER(b.remote_url) = LOWER(?)
                 OR LOWER(b.remote_url) LIKE '%/undefined%'
                 OR LOWER(b.remote_id) GLOB 'ember[0-9]*'
                 OR LOWER(b.remote_id) LIKE 'fallback:linkedin:%'
               )
               AND LOWER(c.notification_display_name) = LOWER(?)
             LIMIT 1",
        )
        .bind(platform.as_str())
        .bind(target_url(Platform::Linkedin))
        .bind(&item.display_name)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(AppError::from);
    }

    Ok(None)
}

async fn wait_for_load(manager: &BrowserManager, tab_id: Uuid) -> AppResult<()> {
    for _ in 0..80 {
        let tab = manager.tab(tab_id)?;
        if tab.load_state == BrowserLoadState::Loaded {
            return Ok(());
        }
        if tab.load_state == BrowserLoadState::Failed {
            return Err(AppError::Internal(
                "the platform inbox failed to load in Goalbar Browser".to_owned(),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    Err(AppError::Timeout("loading the platform inbox".to_owned()))
}

async fn ensure_local_account(
    transaction: &mut Transaction<'_, Sqlite>,
    platform: Platform,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO connected_accounts (id, platform, client_id, remote_account_id, display_name, secret_ref, scopes_json, capabilities_json, token_expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'Browser inbox', ?, '[]', ?, NULL, 'connected', ?, ?) ON CONFLICT(platform, remote_account_id) DO NOTHING")
        .bind(browser_account_id(platform))
        .bind(platform.as_str())
        .bind(LOCAL_BROWSER_CLIENT_ID)
        .bind(LOCAL_BROWSER_REMOTE_ACCOUNT_ID)
        .bind(format!("local/browser-inbox/{}", platform.as_str()))
        .bind(LOCAL_CAPABILITIES_JSON)
        .bind(&now)
        .bind(&now)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn insert_conversation(
    transaction: &mut Transaction<'_, Sqlite>,
    platform: Platform,
    conversation_id: &str,
    item: &BrowserInboxItem,
    observed_at: DateTime<Utc>,
    now: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO conversations (id, account_id, relationship_id, platform, remote_id, kind, unread_count, reply_capability, remote_url, updated_at, source, content_state, notification_display_name, seen_at) VALUES (?, ?, NULL, ?, ?, 'direct_message', ?, 'unsupported', ?, ?, 'platform_api', 'notification_excerpt', ?, NULL)")
        .bind(conversation_id)
        .bind(browser_account_id(platform))
        .bind(platform.as_str())
        .bind(format!("browser:{}", item.remote_id))
        .bind(i64::from(item.unread))
        .bind(&item.remote_url)
        .bind(observed_at.to_rfc3339())
        .bind(&item.display_name)
        .execute(&mut **transaction)
        .await?;
    upsert_preview(transaction, conversation_id, item, observed_at, now).await
}

async fn update_conversation(
    transaction: &mut Transaction<'_, Sqlite>,
    platform: Platform,
    conversation_id: &str,
    item: &BrowserInboxItem,
    observed_at: DateTime<Utc>,
    now: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE conversations SET remote_id = ?, unread_count = ?, reply_capability = 'unsupported', remote_url = ?, updated_at = ?, content_state = 'notification_excerpt', notification_display_name = ? WHERE id = ? AND platform = ?")
        .bind(format!("browser:{}", item.remote_id))
        .bind(i64::from(item.unread))
        .bind(&item.remote_url)
        .bind(observed_at.to_rfc3339())
        .bind(&item.display_name)
        .bind(conversation_id)
        .bind(platform.as_str())
        .execute(&mut **transaction)
        .await?;
    upsert_preview(transaction, conversation_id, item, observed_at, now).await
}

async fn upsert_preview(
    transaction: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    item: &BrowserInboxItem,
    observed_at: DateTime<Utc>,
    _now: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO messages (id, conversation_id, remote_id, sender_remote_id, body, direction, sent_at) VALUES (?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(conversation_id, remote_id) DO UPDATE SET body = excluded.body, direction = excluded.direction, sent_at = excluded.sent_at")
        .bind(Uuid::new_v4().to_string())
        .bind(conversation_id)
        .bind(format!("browser:{}:preview", item.remote_id))
        .bind(&item.preview)
        .bind(item.direction.as_str())
        .bind(observed_at.to_rfc3339())
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn record_state(
    transaction: &mut Transaction<'_, Sqlite>,
    platform: Platform,
    status: BrowserInboxScanStatus,
    item_count: u32,
    now: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO browser_inbox_scan_state (platform, status, item_count, last_scanned_at) VALUES (?, ?, ?, ?) ON CONFLICT(platform) DO UPDATE SET status = excluded.status, item_count = excluded.item_count, last_scanned_at = excluded.last_scanned_at")
        .bind(platform.as_str())
        .bind(status.as_str())
        .bind(i64::from(item_count))
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

fn observed_at(value: Option<&str>, now: DateTime<Utc>, index: usize) -> DateTime<Utc> {
    let fallback = now - Duration::seconds(index as i64);
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback;
    };
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return parsed.with_timezone(&Utc);
    }
    let compact = value.to_ascii_lowercase().replace(' ', "");
    let units = [
        ("mo", 30 * 24 * 60 * 60),
        ("y", 365 * 24 * 60 * 60),
        ("w", 7 * 24 * 60 * 60),
        ("d", 24 * 60 * 60),
        ("h", 60 * 60),
        ("m", 60),
        ("s", 1),
    ];
    for (suffix, seconds) in units {
        if let Some(amount) = compact
            .strip_suffix(suffix)
            .and_then(|raw| raw.parse::<i64>().ok())
        {
            return now - Duration::seconds(amount.saturating_mul(seconds));
        }
    }
    if compact == "yesterday" {
        return now - Duration::days(1);
    }
    for format in ["%b%d", "%B%d"] {
        if let Ok(date) = NaiveDate::parse_from_str(
            &format!("{}{}", value.replace(' ', ""), now.year()),
            &format!("{format}%Y"),
        ) && let Some(date_time) = date.and_hms_opt(12, 0, 0)
        {
            return DateTime::<Utc>::from_naive_utc_and_offset(date_time, Utc);
        }
    }
    fallback
}

const fn target_url(platform: Platform) -> &'static str {
    match platform {
        Platform::X => "https://x.com/messages",
        Platform::Reddit => "https://www.reddit.com/message/inbox",
        Platform::Linkedin => "https://www.linkedin.com/messaging/",
    }
}

const fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::X => "X",
        Platform::Reddit => "Reddit",
        Platform::Linkedin => "LinkedIn",
    }
}

const fn browser_account_id(platform: Platform) -> &'static str {
    match platform {
        Platform::X => "00000000-0000-4000-8000-000000000201",
        Platform::Reddit => "00000000-0000-4000-8000-000000000202",
        Platform::Linkedin => "00000000-0000-4000-8000-000000000203",
    }
}

#[cfg(test)]
mod tests {
    use crate::app_state::AppState;
    use crate::browser::BrowserManager;
    use crate::browser::inbox::{
        BrowserInboxDirection, BrowserInboxItem, BrowserInboxPageScan, BrowserInboxPageState,
        BrowserInboxScanMode, BrowserInboxScanStop,
    };
    use crate::db::Database;
    use crate::db::repositories::platform::PlatformRepository;
    use crate::db::repositories::relationship::RelationshipRepository;
    use crate::domain::Platform;
    use crate::domain::relationship::ConversationSource;
    use crate::error::AppError;
    use crate::services::communication::CommunicationService;

    use super::BrowserInboxService;

    #[tokio::test]
    async fn browser_scan_ingestion_is_idempotent_and_local_only() {
        let database = Database::in_memory().await.expect("database");
        let service = BrowserInboxService::new(BrowserManager::default(), database.pool().clone());
        let scan = BrowserInboxPageScan {
            state: BrowserInboxPageState::Ready,
            mode: BrowserInboxScanMode::Initial,
            stop: BrowserInboxScanStop::Exhausted,
            items: vec![
                BrowserInboxItem {
                    remote_id: "messages/ari".to_owned(),
                    display_name: "Ari".to_owned(),
                    preview: "Can we compare notes?".to_owned(),
                    unread: true,
                    remote_url: "https://x.com/messages/ari".to_owned(),
                    profile_url: Some("https://x.com/ari".to_owned()),
                    timestamp: Some("6d".to_owned()),
                    direction: BrowserInboxDirection::Inbound,
                },
                BrowserInboxItem {
                    remote_id: "messages/mina".to_owned(),
                    display_name: "Mina".to_owned(),
                    preview: "You: Thanks!".to_owned(),
                    unread: false,
                    remote_url: "https://x.com/messages/mina".to_owned(),
                    profile_url: None,
                    timestamp: Some("2w".to_owned()),
                    direction: BrowserInboxDirection::Outbound,
                },
            ],
        };
        let first = service
            .ingest(Platform::X, scan.clone())
            .await
            .expect("first scan");
        let mut rescan = scan;
        rescan.items[0].profile_url = None;
        let second = service
            .ingest(Platform::X, rescan)
            .await
            .expect("second scan");
        assert_eq!((first.imported, first.updated), (2, 0));
        assert_eq!((second.imported, second.updated), (0, 2));

        let conversations = RelationshipRepository::new(database.pool().clone())
            .conversations()
            .await
            .expect("conversations");
        assert_eq!(conversations.len(), 2);
        assert!(
            conversations
                .iter()
                .all(|row| row.source == ConversationSource::BrowserScan)
        );
        assert_eq!(
            conversations
                .iter()
                .find(|row| row.display_name == "Ari")
                .and_then(|row| row.profile_url.as_deref()),
            Some("https://x.com/ari")
        );
        assert!(
            PlatformRepository::new(database.pool().clone())
                .list()
                .await
                .expect("visible accounts")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn linkedin_rescan_repairs_legacy_placeholder_rows_without_duplication() {
        let database = Database::in_memory().await.expect("database");
        let service = BrowserInboxService::new(BrowserManager::default(), database.pool().clone());
        service
            .ingest(
                Platform::Linkedin,
                BrowserInboxPageScan {
                    state: BrowserInboxPageState::Ready,
                    mode: BrowserInboxScanMode::Initial,
                    stop: BrowserInboxScanStop::Exhausted,
                    items: vec![BrowserInboxItem {
                        remote_id: "ember47".to_owned(),
                        display_name: "Ross McIntyre".to_owned(),
                        preview: "Status is reachable".to_owned(),
                        unread: false,
                        remote_url:
                            "https://www.linkedin.com/messaging/thread/2-mailbox/undefined/"
                                .to_owned(),
                        profile_url: None,
                        timestamp: None,
                        direction: BrowserInboxDirection::Inbound,
                    }],
                },
            )
            .await
            .expect("legacy scan");

        let repaired = service
            .ingest(
                Platform::Linkedin,
                BrowserInboxPageScan {
                    state: BrowserInboxPageState::Ready,
                    mode: BrowserInboxScanMode::Initial,
                    stop: BrowserInboxScanStop::Exhausted,
                    items: vec![BrowserInboxItem {
                        remote_id: "messaging/thread/2-mailbox".to_owned(),
                        display_name: "Ross McIntyre".to_owned(),
                        preview: "A newer preview".to_owned(),
                        unread: true,
                        remote_url: "https://www.linkedin.com/messaging/thread/2-mailbox/"
                            .to_owned(),
                        profile_url: Some("https://www.linkedin.com/in/ross-mcintyre/".to_owned()),
                        timestamp: None,
                        direction: BrowserInboxDirection::Inbound,
                    }],
                },
            )
            .await
            .expect("repair scan");

        assert_eq!((repaired.imported, repaired.updated), (0, 1));
        let rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM browser_inbox_ingestions WHERE platform = ?")
                .bind("linkedin")
                .fetch_one(database.pool())
                .await
                .expect("ingestion count");
        assert_eq!(rows, 1);
        let stored: (String, String) = sqlx::query_as(
            "SELECT remote_id, remote_url FROM browser_inbox_ingestions WHERE platform = ?",
        )
        .bind("linkedin")
        .fetch_one(database.pool())
        .await
        .expect("repaired ingestion");
        assert_eq!(
            stored,
            (
                "messaging/thread/2-mailbox".to_owned(),
                "https://www.linkedin.com/messaging/thread/2-mailbox/".to_owned()
            )
        );
        let conversation = RelationshipRepository::new(database.pool().clone())
            .conversations()
            .await
            .expect("repaired conversation")
            .remove(0);
        assert_eq!(
            conversation.remote_url.as_deref(),
            Some("https://www.linkedin.com/messaging/thread/2-mailbox/")
        );
    }

    #[tokio::test]
    async fn linkedin_scan_stays_full_until_the_profile_upgrade_is_captured() {
        let database = Database::in_memory().await.expect("database");
        let service = BrowserInboxService::new(BrowserManager::default(), database.pool().clone());
        service
            .ingest(
                Platform::Linkedin,
                BrowserInboxPageScan {
                    state: BrowserInboxPageState::Ready,
                    mode: BrowserInboxScanMode::Initial,
                    stop: BrowserInboxScanStop::Exhausted,
                    items: vec![BrowserInboxItem {
                        remote_id: "fallback:linkedin:vy nguyen".to_owned(),
                        display_name: "Vy Nguyen".to_owned(),
                        preview: "Status is reachable".to_owned(),
                        unread: false,
                        remote_url: "https://www.linkedin.com/messaging/".to_owned(),
                        profile_url: None,
                        timestamp: None,
                        direction: BrowserInboxDirection::Inbound,
                    }],
                },
            )
            .await
            .expect("legacy scan");

        assert_eq!(
            service
                .scan_mode(Platform::Linkedin)
                .await
                .expect("scan mode"),
            BrowserInboxScanMode::Initial
        );
        sqlx::query(
            "UPDATE browser_inbox_ingestions
             SET profile_url = 'https://www.linkedin.com/in/vy-nguyen/',
                 remote_url = 'https://www.linkedin.com/messaging/thread/2-mailbox/'
             WHERE platform = 'linkedin'",
        )
        .execute(database.pool())
        .await
        .expect("save profile");
        assert_eq!(
            service
                .scan_mode(Platform::Linkedin)
                .await
                .expect("scan mode"),
            BrowserInboxScanMode::Incremental
        );
    }

    #[tokio::test]
    async fn linkedin_scan_stays_full_when_distinct_rows_share_a_thread_url() {
        let database = Database::in_memory().await.expect("database");
        let service = BrowserInboxService::new(BrowserManager::default(), database.pool().clone());
        let shared_url = "https://www.linkedin.com/messaging/thread/wrong-thread/";
        service
            .ingest(
                Platform::Linkedin,
                BrowserInboxPageScan {
                    state: BrowserInboxPageState::Ready,
                    mode: BrowserInboxScanMode::Initial,
                    stop: BrowserInboxScanStop::Exhausted,
                    items: vec![
                        BrowserInboxItem {
                            remote_id: "fallback:linkedin:mina".to_owned(),
                            display_name: "Mina".to_owned(),
                            preview: "Status is reachable".to_owned(),
                            unread: false,
                            remote_url: shared_url.to_owned(),
                            profile_url: Some("https://www.linkedin.com/in/mina/".to_owned()),
                            timestamp: None,
                            direction: BrowserInboxDirection::Inbound,
                        },
                        BrowserInboxItem {
                            remote_id: "fallback:linkedin:ross".to_owned(),
                            display_name: "Ross".to_owned(),
                            preview: "Status is reachable".to_owned(),
                            unread: false,
                            remote_url: shared_url.to_owned(),
                            profile_url: Some("https://www.linkedin.com/in/ross/".to_owned()),
                            timestamp: None,
                            direction: BrowserInboxDirection::Inbound,
                        },
                    ],
                },
            )
            .await
            .expect("legacy scan");

        assert_eq!(
            service
                .scan_mode(Platform::Linkedin)
                .await
                .expect("scan mode"),
            BrowserInboxScanMode::Initial
        );
    }

    #[tokio::test]
    async fn browser_scan_approvals_cannot_send_through_platform_adapters() {
        let state = AppState::for_tests().await.expect("state");
        let service =
            BrowserInboxService::new(state.browser.clone(), state.database.pool().clone());
        service
            .ingest(
                Platform::Linkedin,
                BrowserInboxPageScan {
                    state: BrowserInboxPageState::Ready,
                    mode: BrowserInboxScanMode::Initial,
                    stop: BrowserInboxScanStop::Exhausted,
                    items: vec![BrowserInboxItem {
                        remote_id: "messaging/thread/mina".to_owned(),
                        display_name: "Mina".to_owned(),
                        preview: "Can we compare notes?".to_owned(),
                        unread: true,
                        remote_url: "https://www.linkedin.com/messaging/thread/mina/".to_owned(),
                        profile_url: None,
                        timestamp: None,
                        direction: BrowserInboxDirection::Inbound,
                    }],
                },
            )
            .await
            .expect("browser ingestion");
        let conversation = RelationshipRepository::new(state.database.pool().clone())
            .conversations()
            .await
            .expect("conversations")
            .remove(0);
        let communication =
            CommunicationService::new(state.database.pool().clone(), state.platforms.clone());
        let body = "Thanks for reaching out.";
        let approval = communication
            .approve(conversation.id, body, "direct_message")
            .await
            .expect("approval");
        let error = communication
            .send(
                state.secrets.as_ref(),
                conversation.id,
                approval.id,
                body.to_owned(),
                None,
            )
            .await
            .expect_err("browser preview send must be blocked");
        assert!(matches!(error, AppError::Unsupported(_)));
    }
}
