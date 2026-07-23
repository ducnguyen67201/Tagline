#![allow(clippy::unwrap_used)]

use goalbar_lib::db::Database;

#[tokio::test]
async fn migration_schema_enforces_platform_enum() {
    let database = Database::in_memory().await.expect("database");
    let result = sqlx::query("INSERT INTO connected_accounts (id, platform, client_id, remote_account_id, display_name, secret_ref, scopes_json, capabilities_json, status, created_at, updated_at) VALUES ('1', 'threads', 'client', 'remote', 'Founder', 'secret', '[]', '{}', 'connected', 'now', 'now')")
        .execute(database.pool())
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn migration_six_adds_history_tables_without_changing_operational_data() {
    let database = Database::in_memory().await.expect("database");
    sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind("migration-test")
        .bind(r#"{"preserved":true}"#)
        .bind("2026-07-22T00:00:00Z")
        .execute(database.pool())
        .await
        .expect("seed operational record");

    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('ingestion_sources', 'ingestion_runs', 'activity_items', 'browser_checkpoints')",
    )
    .fetch_one(database.pool())
    .await
    .expect("history tables");
    let setting: String = sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = ?")
        .bind("migration-test")
        .fetch_one(database.pool())
        .await
        .expect("preserved operational record");
    assert_eq!(tables, 4);
    assert_eq!(setting, r#"{"preserved":true}"#);
}

#[tokio::test]
async fn migration_seven_adds_staged_research_without_changing_operational_data() {
    let database = Database::in_memory().await.expect("database");
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('browser_research_trace', 'browser_research_findings')",
    )
    .fetch_one(database.pool())
    .await
    .expect("research tables");
    assert_eq!(tables, 2);
}

#[tokio::test]
async fn migration_eight_allows_browser_use_navigation_trace_actions() {
    let database = Database::in_memory().await.expect("database");
    let schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("browser_research_trace")
            .fetch_one(database.pool())
            .await
            .expect("browser trace schema");
    assert!(schema.contains("'open_link'"));
    assert!(schema.contains("'go_back'"));
}

#[tokio::test]
async fn migration_nine_adds_the_controlled_growth_ledger() {
    let database = Database::in_memory().await.expect("database");
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('growth_actions', 'growth_action_executions', 'growth_action_metrics')",
    )
    .fetch_one(database.pool())
    .await
    .expect("growth loop tables");
    assert_eq!(tables, 3);

    let approvals_schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("approvals")
            .fetch_one(database.pool())
            .await
            .expect("approval schema");
    assert!(approvals_schema.contains("'growth_action'"));

    let icp_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('icp_hypotheses') WHERE name IN ('version', 'parent_id')",
    )
    .fetch_one(database.pool())
    .await
    .expect("versioned ICP columns");
    assert_eq!(icp_columns, 2);
}

#[tokio::test]
async fn migration_ten_adds_typed_local_email_notifications() {
    let database = Database::in_memory().await.expect("database");
    let notification_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name IN ('source', 'content_state', 'notification_display_name', 'seen_at')",
    )
    .fetch_one(database.pool())
    .await
    .expect("conversation notification columns");
    assert_eq!(notification_columns, 4);

    let notification_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'email_notification_ingestions'",
    )
    .fetch_one(database.pool())
    .await
    .expect("notification ingestion table");
    assert_eq!(notification_table, 1);

    sqlx::query("INSERT INTO connected_accounts (id, platform, client_id, remote_account_id, display_name, secret_ref, scopes_json, capabilities_json, status, created_at, updated_at) VALUES ('email-account', 'x', 'local', 'email', 'Email', 'local/email', '[]', '{}', 'connected', 'now', 'now')")
        .execute(database.pool())
        .await
        .expect("seed notification account");
    let invalid_source = sqlx::query("INSERT INTO conversations (id, account_id, platform, remote_id, kind, unread_count, reply_capability, updated_at, source, content_state) VALUES ('conversation', 'email-account', 'x', 'remote', 'comment_thread', 1, 'unsupported', 'now', 'browser_scrape', 'complete')")
        .execute(database.pool())
        .await;
    assert!(invalid_source.is_err());

    let table_schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("conversations")
            .fetch_one(database.pool())
            .await
            .expect("conversation schema");
    assert!(table_schema.contains("'email_notification'"));
    assert!(table_schema.contains("'notification_excerpt'"));
}

#[tokio::test]
async fn migration_eleven_adds_optional_founder_starting_context() {
    let database = Database::in_memory().await.expect("database");
    let founder_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('founder_profiles') WHERE name IN ('website_url', 'ideal_customer')",
    )
    .fetch_one(database.pool())
    .await
    .expect("founder context columns");
    assert_eq!(founder_columns, 2);

    sqlx::query(
        "INSERT INTO founder_profiles (id, name, product_name, offer, expertise, goals_json, boundaries_json, onboarding_completed, created_at, updated_at) VALUES ('legacy', 'Duc', 'Lab', 'Growth system', 'Product', '[]', '[]', 1, 'now', 'now')",
    )
    .execute(database.pool())
    .await
    .expect("legacy-shaped founder record");
    let defaults: (Option<String>, String) = sqlx::query_as(
        "SELECT website_url, ideal_customer FROM founder_profiles WHERE id = 'legacy'",
    )
    .fetch_one(database.pool())
    .await
    .expect("founder context defaults");
    assert_eq!(defaults, (None, String::new()));
}

#[tokio::test]
async fn migration_twelve_adds_browser_inbox_ingestions() {
    let database = Database::in_memory().await.expect("database");
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('browser_inbox_ingestions', 'browser_inbox_scan_state')",
    )
    .fetch_one(database.pool())
    .await
    .expect("browser inbox tables");
    assert_eq!(tables, 2);

    let ingestion_schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("browser_inbox_ingestions")
            .fetch_one(database.pool())
            .await
            .expect("browser inbox ingestion schema");
    assert!(ingestion_schema.contains("UNIQUE"));
    assert!(ingestion_schema.contains("'linkedin'"));
}

#[tokio::test]
async fn migration_thirteen_adds_a_truthful_saved_reply_ledger() {
    let database = Database::in_memory().await.expect("database");
    let schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("saved_browser_replies")
            .fetch_one(database.pool())
            .await
            .expect("saved reply schema");

    assert!(schema.contains("'prepared'"));
    assert!(schema.contains("'confirmed_posted'"));
    assert!(schema.contains("'reddit'"));
}

#[tokio::test]
async fn migration_fourteen_supports_partial_inbox_scans() {
    let database = Database::in_memory().await.expect("database");
    sqlx::query(
        "INSERT INTO browser_inbox_scan_state (platform, status, item_count, last_scanned_at) VALUES ('linkedin', 'partial', 500, 'now')",
    )
    .execute(database.pool())
    .await
    .expect("partial scan status");

    let status: String = sqlx::query_scalar(
        "SELECT status FROM browser_inbox_scan_state WHERE platform = 'linkedin'",
    )
    .fetch_one(database.pool())
    .await
    .expect("stored partial status");
    assert_eq!(status, "partial");
}

#[tokio::test]
async fn migration_fifteen_persists_browser_inbox_profile_links() {
    let database = Database::in_memory().await.expect("database");
    let profile_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('browser_inbox_ingestions') WHERE name = 'profile_url'",
    )
    .fetch_one(database.pool())
    .await
    .expect("browser inbox profile column");
    assert_eq!(profile_columns, 1);
}

#[tokio::test]
async fn migration_sixteen_persists_per_chat_browser_access() {
    let database = Database::in_memory().await.expect("database");
    let schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("codex_chat_settings")
            .fetch_one(database.pool())
            .await
            .expect("Codex chat settings schema");

    assert!(schema.contains("thread_id TEXT PRIMARY KEY"));
    assert!(schema.contains("browser_access_enabled"));
}
