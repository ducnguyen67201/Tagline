#![cfg_attr(test, allow(clippy::unwrap_used))]

pub mod adapters;
pub mod app_state;
pub mod browser;
pub mod commands;
pub mod conductor;
pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod logging;
pub mod secrets;
pub mod services;
pub mod terminal;
pub mod updates;
pub mod validation;

use tauri::Manager as _;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(updates::plugin())
        .setup(|app| {
            let default_dir = app.path().app_data_dir()?;
            let data_dir = config::resolve_data_dir(default_dir)
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            let database_path = data_dir.join("goalbar.sqlite");
            let state = tauri::async_runtime::block_on(app_state::AppState::open(&database_path))
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            services::scheduler::start(state.clone());
            app.manage(state);
            updates::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap::get_bootstrap_state,
            commands::agents::detect_agents,
            commands::agents::run_agent_task,
            commands::agents::send_codex_chat_message,
            commands::agents::get_codex_chat_state,
            commands::agents::list_codex_chats,
            commands::agents::select_codex_chat,
            commands::agents::interrupt_codex_chat,
            commands::agents::new_codex_chat,
            commands::agents::delete_codex_chat,
            commands::agents::set_codex_chat_browser_access,
            commands::agents::cancel_job,
            commands::onboarding::save_founder_profile,
            commands::onboarding::update_founder_profile,
            commands::onboarding::save_voice_profile,
            commands::onboarding::generate_icp_hypotheses,
            commands::onboarding::list_icp_hypotheses,
            commands::onboarding::revise_icp_hypothesis,
            commands::onboarding::accept_icp_hypothesis,
            commands::content::generate_content_variants,
            commands::content::approve_variant,
            commands::content::publish_variant,
            commands::platforms::list_platform_statuses,
            commands::platforms::begin_platform_oauth,
            commands::platforms::get_oauth_status,
            commands::platforms::complete_platform_oauth,
            commands::platforms::disconnect_platform,
            commands::platforms::sync_platform_now,
            commands::inbox::list_conversations,
            commands::inbox::sync_email_notifications,
            commands::inbox::scan_browser_inbox,
            commands::inbox::mark_conversation_read,
            commands::inbox::draft_reply,
            commands::inbox::approve_reply,
            commands::inbox::send_reply,
            commands::growth::get_growth_overview,
            commands::growth::get_growth_loop_overview,
            commands::growth::propose_growth_action,
            commands::growth::revise_growth_action,
            commands::growth::approve_growth_action,
            commands::growth::record_growth_action_execution,
            commands::growth::record_growth_action_metric,
            commands::growth::record_growth_action_learning,
            commands::growth::generate_weekly_review,
            commands::growth::accept_learning,
            commands::settings::check_keyring,
            commands::settings::open_remote_url,
            commands::settings::export_local_data,
            commands::settings::backup_local_database,
            commands::settings::factory_reset_local_data,
            commands::browser::list_browser_tabs,
            commands::browser::create_browser_tab,
            commands::browser::activate_browser_tab,
            commands::browser::update_browser_bounds,
            commands::browser::navigate_browser_tab,
            commands::browser::prepare_browser_reply,
            commands::browser::browser_go_back,
            commands::browser::browser_go_forward,
            commands::browser::reload_browser_tab,
            commands::browser::close_browser_tab,
            commands::browser::hide_browser_views,
            commands::browser::clear_browser_data,
            commands::browser::get_browser_panel_width,
            commands::browser::set_browser_panel_width,
            commands::browser::observe_browser_tab,
            commands::browser::preview_browser_capture,
            commands::browser::commit_browser_capture,
            commands::browser::start_browser_collection,
            commands::browser::cancel_browser_collection,
            commands::browser::list_browser_research_findings,
            commands::browser::list_browser_research_trace,
            commands::browser::review_browser_research_finding,
            commands::history::choose_history_archive,
            commands::history::preview_history_archive,
            commands::history::import_history_archive,
            commands::history::get_history_overview,
            commands::terminal::list_terminal_sessions,
            commands::terminal::create_terminal_session,
            commands::terminal::write_terminal_session,
            commands::terminal::resize_terminal_session,
            commands::terminal::close_terminal_session,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        panic!("failed to run Goalbar: {error}");
    }
}
