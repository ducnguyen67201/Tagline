use base64::Engine as _;
use sha2::{Digest as _, Sha256};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

struct EmbeddedMigration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[EmbeddedMigration] = &[
    EmbeddedMigration {
        version: 1,
        name: "core",
        sql: include_str!("../../migrations/0001_core.sql"),
    },
    EmbeddedMigration {
        version: 2,
        name: "growth_memory",
        sql: include_str!("../../migrations/0002_growth_memory.sql"),
    },
    EmbeddedMigration {
        version: 3,
        name: "content",
        sql: include_str!("../../migrations/0003_content.sql"),
    },
    EmbeddedMigration {
        version: 4,
        name: "platforms",
        sql: include_str!("../../migrations/0004_platforms.sql"),
    },
    EmbeddedMigration {
        version: 5,
        name: "relationships_jobs",
        sql: include_str!("../../migrations/0005_relationships_jobs.sql"),
    },
    EmbeddedMigration {
        version: 6,
        name: "browser_history",
        sql: include_str!("../../migrations/0006_browser_history.sql"),
    },
    EmbeddedMigration {
        version: 7,
        name: "agent_research",
        sql: include_str!("../../migrations/0007_agent_research.sql"),
    },
    EmbeddedMigration {
        version: 8,
        name: "browser_use_trace",
        sql: include_str!("../../migrations/0008_browser_use_trace.sql"),
    },
    EmbeddedMigration {
        version: 9,
        name: "controlled_growth_loop",
        sql: include_str!("../../migrations/0009_controlled_growth_loop.sql"),
    },
    EmbeddedMigration {
        version: 10,
        name: "email_notifications",
        sql: include_str!("../../migrations/0010_email_notifications.sql"),
    },
    EmbeddedMigration {
        version: 11,
        name: "founder_starting_context",
        sql: include_str!("../../migrations/0011_founder_starting_context.sql"),
    },
    EmbeddedMigration {
        version: 12,
        name: "browser_inbox",
        sql: include_str!("../../migrations/0012_browser_inbox.sql"),
    },
    EmbeddedMigration {
        version: 13,
        name: "saved_browser_replies",
        sql: include_str!("../../migrations/0013_saved_browser_replies.sql"),
    },
    EmbeddedMigration {
        version: 14,
        name: "browser_inbox_full_scan",
        sql: include_str!("../../migrations/0014_browser_inbox_full_scan.sql"),
    },
    EmbeddedMigration {
        version: 15,
        name: "browser_inbox_profiles",
        sql: include_str!("../../migrations/0015_browser_inbox_profiles.sql"),
    },
    EmbeddedMigration {
        version: 16,
        name: "codex_chat_settings",
        sql: include_str!("../../migrations/0016_codex_chat_settings.sql"),
    },
];

pub async fn run(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _fgl_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    )
    .execute(pool)
    .await?;

    for migration in MIGRATIONS {
        let checksum = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(migration.sql.as_bytes()));
        let applied_checksum = sqlx::query_scalar::<_, String>(
            "SELECT checksum FROM _fgl_migrations WHERE version = ?",
        )
        .bind(migration.version)
        .fetch_optional(pool)
        .await?;
        if let Some(applied_checksum) = applied_checksum {
            if applied_checksum != checksum {
                return Err(AppError::Internal(format!(
                    "embedded migration {} ({}) changed after it was applied",
                    migration.version, migration.name
                )));
            }
            continue;
        }

        let mut transaction = pool.begin().await?;
        sqlx::raw_sql(migration.sql)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO _fgl_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(migration.version)
        .bind(migration.name)
        .bind(checksum)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    Ok(())
}
