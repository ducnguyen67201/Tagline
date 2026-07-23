use sqlx::SqlitePool;

use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct CodexChatSettingsRepository {
    pool: SqlitePool,
}

impl CodexChatSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn browser_access_enabled(&self, thread_id: &str) -> AppResult<bool> {
        let value = sqlx::query_scalar::<_, i64>(
            "SELECT browser_access_enabled FROM codex_chat_settings WHERE thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(value.is_none_or(|value| value != 0))
    }

    pub async fn set_browser_access_enabled(
        &self,
        thread_id: &str,
        enabled: bool,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO codex_chat_settings (thread_id, browser_access_enabled, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(thread_id) DO UPDATE SET browser_access_enabled = excluded.browser_access_enabled, updated_at = excluded.updated_at",
        )
        .bind(thread_id)
        .bind(i64::from(enabled))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, thread_id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM codex_chat_settings WHERE thread_id = ?")
            .bind(thread_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::CodexChatSettingsRepository;
    use crate::db::Database;

    #[tokio::test]
    async fn browser_access_is_isolated_and_deleted_with_its_chat() {
        let database = Database::in_memory().await.expect("database");
        let repository = CodexChatSettingsRepository::new(database.pool().clone());

        assert!(
            repository
                .browser_access_enabled("chat-one")
                .await
                .expect("default")
        );
        repository
            .set_browser_access_enabled("chat-one", false)
            .await
            .expect("disable");
        assert!(
            !repository
                .browser_access_enabled("chat-one")
                .await
                .expect("chat one")
        );
        assert!(
            repository
                .browser_access_enabled("chat-two")
                .await
                .expect("chat two")
        );

        repository.delete("chat-one").await.expect("delete");
        assert!(
            repository
                .browser_access_enabled("chat-one")
                .await
                .expect("deleted default")
        );
    }
}
