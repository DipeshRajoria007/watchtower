use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime::spawn,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::RwLock,
};

const TRAY_ID: &str = "watchtower-tray";
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
struct SupervisorStatus {
    state: Arc<RwLock<String>>,
}

impl SupervisorStatus {
    async fn set(&self, value: impl Into<String>) {
        let mut state = self.state.write().await;
        *state = value.into();
    }

    async fn get(&self) -> String {
        self.state.read().await.clone()
    }
}

#[derive(Clone, Default)]
struct SupervisorControl {
    shutdown_requested: Arc<AtomicBool>,
    sidecar_pid: Arc<Mutex<Option<u32>>>,
}

impl SupervisorControl {
    fn request_shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);
    }

    fn is_shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    fn set_sidecar_pid(&self, pid: Option<u32>) {
        if let Ok(mut guard) = self.sidecar_pid.lock() {
            *guard = pid;
        }
    }

    fn clear_sidecar_pid(&self) {
        if let Ok(mut guard) = self.sidecar_pid.lock() {
            let _ = guard.take();
        }
    }

    fn terminate_sidecar(&self) -> Result<bool, String> {
        let pid = self
            .sidecar_pid
            .lock()
            .map_err(|_| "failed to lock sidecar pid state".to_string())?
            .take();
        let Some(pid) = pid else {
            return Ok(false);
        };

        let pid_string = pid.to_string();
        let term_status = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(&pid_string)
            .status()
            .map_err(|err| format!("failed to send SIGTERM to sidecar pid {pid}: {err}"))?;
        if term_status.success() {
            return Ok(true);
        }

        let kill_status = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(&pid_string)
            .status()
            .map_err(|err| format!("failed to send SIGKILL to sidecar pid {pid}: {err}"))?;
        if kill_status.success() {
            return Ok(true);
        }

        Err(format!(
            "unable to terminate sidecar pid {pid} (SIGTERM status={term_status}, SIGKILL status={kill_status})"
        ))
    }
}

#[derive(Clone)]
struct AppState {
    db_path: Arc<PathBuf>,
    supervisor: SupervisorStatus,
    supervisor_control: SupervisorControl,
}

#[derive(Clone)]
struct TrayStatsSnapshot {
    active_jobs: i64,
    max_concurrent_jobs: i64,
    runs_24h: i64,
    failed_runs_24h: i64,
    success_rate_24h: f64,
    success_streak: i64,
    sidecar_status: String,
    settings_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    id: String,
    workflow: String,
    status: String,
    task_summary: String,
    channel_id: String,
    thread_ts: String,
    created_at: String,
    updated_at: String,
    error_message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobLogEntry {
    id: i64,
    job_id: String,
    level: String,
    stage: String,
    message: String,
    data_json: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    sidecar_status: String,
    settings_configured: bool,
    active_jobs: Vec<RunSummary>,
    recent_runs: Vec<RunSummary>,
    failures: Vec<RunSummary>,
    metrics: DashboardMetrics,
    learning: LearningInsights,
    recommendations: Vec<DashboardRecommendation>,
    channel_heat: Vec<ChannelHeat>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DashboardMetrics {
    runs_24h: i64,
    success_rate_24h: f64,
    failed_runs_24h: i64,
    avg_resolution_seconds_24h: i64,
    unknown_tasks_24h: i64,
    catchup_recovered_24h: i64,
    success_streak: i64,
    chaos_index: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DashboardRecommendation {
    id: String,
    priority: String,
    title: String,
    detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChannelHeat {
    channel_id: String,
    runs: i64,
    failures: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LearningInsights {
    signals_24h: i64,
    corrections_learned: i64,
    corrections_applied_24h: i64,
    personality_profiles: i64,
    dominant_personality_mode: String,
    top_failure_kind: String,
    top_failure_count: i64,
    profiles_by_mode: Vec<PersonalityModeStats>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PersonalityModeStats {
    mode: String,
    count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    slack_bot_token: String,
    slack_app_token: String,
    owner_slack_user_ids: String,
    bot_user_id: String,
    bugs_and_updates_channel_id: String,
    newton_web_path: String,
    newton_api_path: String,
    max_concurrent_jobs: i64,
    pr_review_timeout_ms: i64,
    bug_fix_timeout_ms: i64,
    repo_classifier_threshold: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsResponse {
    configured: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            slack_bot_token: String::new(),
            slack_app_token: String::new(),
            owner_slack_user_ids: String::new(),
            bot_user_id: String::new(),
            bugs_and_updates_channel_id: "C01H25RNLJH".to_string(),
            newton_web_path: String::new(),
            newton_api_path: String::new(),
            max_concurrent_jobs: 2,
            pr_review_timeout_ms: 720_000,
            bug_fix_timeout_ms: 2_700_000,
            repo_classifier_threshold: 0.75,
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("watchtower supports macOS only");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let app_data_dir = app_handle
                .path()
                .app_data_dir()
                .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|err| format!("failed to create app data dir: {err}"))?;

            let db_path = app_data_dir.join("watchtower.db");
            initialize_db(&db_path).map_err(|err| format!("db init failed: {err}"))?;

            let supervisor = SupervisorStatus::default();
            let supervisor_control = SupervisorControl::default();
            let state = AppState {
                db_path: Arc::new(db_path.clone()),
                supervisor: supervisor.clone(),
                supervisor_control: supervisor_control.clone(),
            };
            app.manage(state.clone());

            setup_tray(app_handle.clone())?;

            let app_handle_for_tray = app_handle.clone();
            let tray_state = state.clone();
            spawn(async move {
                start_tray_refresh_loop(app_handle_for_tray, tray_state).await;
            });

            let app_handle_for_autostart = app_handle.clone();
            spawn(async move {
                if let Err(err) = set_autostart_enabled(&app_handle_for_autostart).await {
                    eprintln!("failed to enable launch-on-login: {err}");
                }
            });

            spawn(start_sidecar_supervisor(
                app_handle,
                db_path,
                supervisor,
                supervisor_control,
            ));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            get_job_logs,
            get_app_settings,
            save_app_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            shutdown_sidecar_for_exit(app_handle);
        }
        _ => {}
    });
}

#[tauri::command]
async fn get_dashboard_data(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let active_jobs = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs WHERE status = 'RUNNING' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let recent_runs = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs ORDER BY updated_at DESC LIMIT 50",
    )?;
    let failures = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let metrics = query_dashboard_metrics(&connection)?;
    let learning = query_learning_insights(&connection)?;
    let channel_heat = query_channel_heat(&connection)?;
    let recommendations = build_recommendations(&metrics, &channel_heat);

    let settings = read_app_settings(&connection)?;

    Ok(DashboardData {
        sidecar_status: state.supervisor.get().await,
        settings_configured: is_settings_complete(&settings),
        active_jobs,
        recent_runs,
        failures,
        metrics,
        learning,
        recommendations,
        channel_heat,
    })
}

#[tauri::command]
async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    read_app_settings(&connection)
}

#[tauri::command]
async fn get_job_logs(
    job_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<JobLogEntry>, String> {
    let max_limit = i64::from(limit.unwrap_or(500)).clamp(1, 1000);
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT id, job_id, level, stage, message, data_json, created_at
             FROM job_logs
             WHERE job_id = ?
             ORDER BY id ASC
             LIMIT ?",
        )
        .map_err(|err| format!("db prepare job_logs failed: {err}"))?;

    let rows = stmt
        .query_map(params![job_id, max_limit], |row| {
            Ok(JobLogEntry {
                id: row.get(0)?,
                job_id: row.get(1)?,
                level: row.get(2)?,
                stage: row.get(3)?,
                message: row.get(4)?,
                data_json: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| format!("db query job_logs failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row job_logs failed: {err}"))?);
    }
    Ok(output)
}

#[tauri::command]
async fn save_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<SaveSettingsResponse, String> {
    validate_settings_for_save(&settings)?;

    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    persist_app_settings(&connection, &settings)?;

    Ok(SaveSettingsResponse {
        configured: is_settings_complete(&settings),
    })
}

fn query_runs(connection: &Connection, sql: &str) -> Result<Vec<RunSummary>, String> {
    let mut stmt = connection
        .prepare(sql)
        .map_err(|err| format!("db prepare failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let workflow: String = row.get(1)?;
            let error_message: Option<String> = row.get(7)?;
            let payload_json: Option<String> = row.get(8)?;
            Ok(RunSummary {
                id: row.get(0)?,
                workflow: workflow.clone(),
                status: row.get(2)?,
                task_summary: derive_task_summary(
                    &workflow,
                    payload_json.as_deref(),
                    error_message.as_deref(),
                ),
                channel_id: row.get(3)?,
                thread_ts: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                error_message,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(output)
}

fn derive_task_summary(
    workflow: &str,
    payload_json: Option<&str>,
    error_message: Option<&str>,
) -> String {
    if let Some(text) = extract_payload_text(payload_json) {
        let cleaned = strip_request_leadin(&clean_slack_text(&text));
        if workflow == "DEV_ASSIST" {
            if let Some(summary) = summarize_dev_assist_command(&cleaned) {
                return summary;
            }
        }
        if workflow == "PR_REVIEW" {
            if let Some(summary) = summarize_pull_request(&cleaned) {
                return summary;
            }
        }
        if !cleaned.is_empty() {
            return sentence_case(&truncate_summary(&cleaned, 96));
        }
    }

    if let Some(message) = error_message {
        let concise = message.split(':').next().unwrap_or(message).trim();
        if !concise.is_empty() {
            return truncate_summary(concise, 72);
        }
    }

    match workflow {
        "PR_REVIEW" => "Pull request review".to_string(),
        "BUG_FIX" => "Bug fix request".to_string(),
        "OWNER_AUTOPILOT" => "Owner request".to_string(),
        "DEV_ASSIST" => "Watchtower command".to_string(),
        _ => "Workflow task".to_string(),
    }
}

fn extract_payload_text(payload_json: Option<&str>) -> Option<String> {
    let payload = payload_json?;
    let parsed: serde_json::Value = serde_json::from_str(payload).ok()?;
    let text = parsed.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn clean_slack_text(raw: &str) -> String {
    let mut output = String::new();
    let mut remainder = raw;

    while let Some(start) = remainder.find('<') {
        output.push_str(&remainder[..start]);
        let token_start = start + 1;
        let Some(end_offset) = remainder[token_start..].find('>') else {
            output.push_str(&remainder[start..]);
            remainder = "";
            break;
        };

        let token_end = token_start + end_offset;
        output.push_str(&decode_slack_token(&remainder[token_start..token_end]));
        remainder = &remainder[token_end + 1..];
    }

    output.push_str(remainder);

    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_slack_token(token: &str) -> String {
    if token.starts_with('@') || token.starts_with('!') {
        return String::new();
    }

    if token.starts_with('#') {
        if let Some((_, label)) = token.split_once('|') {
            return format!("#{}", label.trim_start_matches('#'));
        }
        return "channel".to_string();
    }

    if let Some((url, label)) = token.split_once('|') {
        if !label.is_empty() {
            return label.to_string();
        }
        return url.to_string();
    }

    token.to_string()
}

fn strip_request_leadin(input: &str) -> String {
    let mut cleaned = input.trim();
    let prefixes = [
        "watchtower ",
        "wt ",
        "please ",
        "pls ",
        "can you ",
        "could you ",
        "would you ",
        "hey ",
        "hi ",
        "hello ",
    ];

    loop {
        let lower = cleaned.to_ascii_lowercase();
        let mut matched = false;
        for prefix in prefixes {
            if lower.starts_with(prefix) {
                cleaned = cleaned[prefix.len()..].trim_start_matches([' ', ':', ',', '-']);
                matched = true;
                break;
            }
        }
        if !matched {
            break;
        }
    }

    cleaned.trim().to_string()
}

fn summarize_dev_assist_command(text: &str) -> Option<String> {
    let command = text.trim();
    if command.is_empty() {
        return None;
    }

    let lower = command.to_ascii_lowercase();
    let summary = if lower == "help" {
        "Show available Watchtower commands"
    } else if lower == "status" {
        "Show Watchtower status"
    } else if lower.starts_with("runs") {
        "List recent runs"
    } else if lower.starts_with("failures") {
        "List recent failures"
    } else if lower.starts_with("trace ") {
        "Show trace for a job"
    } else if lower.starts_with("diagnose ") {
        "Diagnose a failed job"
    } else if lower == "learn" {
        "Run the learning pass"
    } else if lower.starts_with("heat") {
        "Show channel heat"
    } else if lower.starts_with("personality set ") {
        "Update personality mode"
    } else if lower.starts_with("personality show") {
        "Show personality mode"
    } else if lower.starts_with("replay ") {
        "Replay a previous job"
    } else if lower.starts_with("fork ") {
        "Fork a previous job"
    } else if lower.starts_with("my queue") {
        "Show my prioritized queue"
    } else {
        return None;
    };

    Some(summary.to_string())
}

fn summarize_pull_request(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|ch: char| matches!(ch, '.' | ',' | ')' | '('));
        let Some(marker_index) = trimmed.find("github.com/") else {
            continue;
        };
        let path = &trimmed[marker_index + "github.com/".len()..];
        let mut parts = path.split('/');
        let Some(owner) = parts.next() else {
            continue;
        };
        let Some(repo) = parts.next() else {
            continue;
        };
        let Some(kind) = parts.next() else {
            continue;
        };
        if kind != "pull" {
            continue;
        }
        let Some(number_part) = parts.next() else {
            continue;
        };
        let number = number_part.trim_matches(|ch: char| !ch.is_ascii_digit());
        if !owner.is_empty() && !repo.is_empty() && !number.is_empty() {
            return Some(format!("Review PR {owner}/{repo}#{number}"));
        }
    }

    None
}

fn truncate_summary(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }

    let soft_limit = max_chars.saturating_sub(3);
    let mut truncated = String::new();

    for word in input.split_whitespace() {
        let next_len = if truncated.is_empty() {
            word.chars().count()
        } else {
            truncated.chars().count() + 1 + word.chars().count()
        };

        if next_len > soft_limit {
            break;
        }

        if !truncated.is_empty() {
            truncated.push(' ');
        }
        truncated.push_str(word);
    }

    if truncated.is_empty() {
        truncated = input.chars().take(soft_limit).collect();
    }

    format!("{truncated}...")
}

fn sentence_case(input: &str) -> String {
    let mut chars = input.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut output = first.to_uppercase().collect::<String>();
    output.push_str(chars.as_str());
    output
}

fn query_dashboard_metrics(connection: &Connection) -> Result<DashboardMetrics, String> {
    let runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query runs_24h failed: {err}"))?;

    let failed_runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'FAILED' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query failed_runs_24h failed: {err}"))?;

    let success_runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'SUCCESS' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query success_runs_24h failed: {err}"))?;

    let avg_resolution_seconds_24h: f64 = connection
        .query_row(
            "SELECT COALESCE(AVG((julianday(updated_at) - julianday(created_at)) * 86400.0), 0.0)
             FROM jobs
             WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query avg_resolution_seconds_24h failed: {err}"))?;

    let unknown_tasks_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE workflow = 'UNKNOWN' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query unknown_tasks_24h failed: {err}"))?;

    let catchup_recovered_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM events WHERE event_id LIKE 'replay:%' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query catchup_recovered_24h failed: {err}"))?;

    let success_rate_24h = if runs_24h <= 0 {
        100.0
    } else {
        ((success_runs_24h as f64 / runs_24h as f64) * 100.0 * 10.0).round() / 10.0
    };

    let success_streak = query_success_streak(connection)?;
    let mut chaos_index = failed_runs_24h * 4 + unknown_tasks_24h * 2;
    if avg_resolution_seconds_24h >= 600.0 {
        chaos_index += 2;
    }
    chaos_index = chaos_index.clamp(0, 100);

    Ok(DashboardMetrics {
        runs_24h,
        success_rate_24h,
        failed_runs_24h,
        avg_resolution_seconds_24h: avg_resolution_seconds_24h.round() as i64,
        unknown_tasks_24h,
        catchup_recovered_24h,
        success_streak,
        chaos_index,
    })
}

fn query_active_job_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'RUNNING'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query active_jobs failed: {err}"))
}

async fn query_tray_stats_snapshot(state: &AppState) -> Result<TrayStatsSnapshot, String> {
    let sidecar_status = state.supervisor.get().await;
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let metrics = query_dashboard_metrics(&connection)?;
    let settings = read_app_settings(&connection)?;

    Ok(TrayStatsSnapshot {
        active_jobs: query_active_job_count(&connection)?,
        max_concurrent_jobs: settings.max_concurrent_jobs.max(1),
        runs_24h: metrics.runs_24h,
        failed_runs_24h: metrics.failed_runs_24h,
        success_rate_24h: metrics.success_rate_24h,
        success_streak: metrics.success_streak,
        sidecar_status,
        settings_configured: is_settings_complete(&settings),
    })
}

fn compact_sidecar_status_label(status: &str, settings_configured: bool) -> &'static str {
    if !settings_configured || status.starts_with("waiting for settings") {
        "setup"
    } else if status.starts_with("running") {
        "running"
    } else if status.starts_with("starting") {
        "starting"
    } else if status.starts_with("restarting") {
        "retrying"
    } else if status.starts_with("failed") || status.starts_with("error") {
        "issue"
    } else if status.starts_with("stopped") {
        "stopped"
    } else {
        "status"
    }
}

fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if (rounded - rounded.round()).abs() < f64::EPSILON {
        format!("{}%", rounded.round() as i64)
    } else {
        format!("{rounded:.1}%")
    }
}

fn format_tray_title(snapshot: &TrayStatsSnapshot) -> String {
    let queue = format!("{}/{}", snapshot.active_jobs, snapshot.max_concurrent_jobs);
    let sidecar_label =
        compact_sidecar_status_label(&snapshot.sidecar_status, snapshot.settings_configured);

    if sidecar_label == "running" {
        format!(
            "WT {queue} active | {}",
            format_percent(snapshot.success_rate_24h)
        )
    } else {
        format!("WT {queue} active | {sidecar_label}")
    }
}

fn format_tray_tooltip(snapshot: &TrayStatsSnapshot) -> String {
    format!(
        "Watchtower | Active jobs: {} / {} | Runs (24h): {} | Failures (24h): {} | Success (24h): {} | Sidecar: {}",
        snapshot.active_jobs,
        snapshot.max_concurrent_jobs,
        snapshot.runs_24h,
        snapshot.failed_runs_24h,
        format_percent(snapshot.success_rate_24h),
        sentence_case(&snapshot.sidecar_status)
    )
}

fn build_tray_menu(
    app_handle: &AppHandle,
    snapshot: &TrayStatsSnapshot,
) -> Result<Menu<tauri::Wry>, String> {
    let queue_text = if snapshot.settings_configured {
        format!(
            "Active jobs: {} / {}",
            snapshot.active_jobs, snapshot.max_concurrent_jobs
        )
    } else {
        format!(
            "Active jobs: {} / {} (setup incomplete)",
            snapshot.active_jobs, snapshot.max_concurrent_jobs
        )
    };

    let active = MenuItem::with_id(app_handle, "stats_active", queue_text, false, None::<&str>)
        .map_err(|err| format!("tray menu active jobs failed: {err}"))?;
    let runs = MenuItem::with_id(
        app_handle,
        "stats_runs_24h",
        format!("Runs last 24h: {}", snapshot.runs_24h),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu runs failed: {err}"))?;
    let failures = MenuItem::with_id(
        app_handle,
        "stats_failures_24h",
        format!("Failures last 24h: {}", snapshot.failed_runs_24h),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu failures failed: {err}"))?;
    let success = MenuItem::with_id(
        app_handle,
        "stats_success_24h",
        format!(
            "Success rate last 24h: {}",
            format_percent(snapshot.success_rate_24h)
        ),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu success failed: {err}"))?;
    let streak = MenuItem::with_id(
        app_handle,
        "stats_success_streak",
        format!("Success streak: {}", snapshot.success_streak),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu streak failed: {err}"))?;
    let sidecar = MenuItem::with_id(
        app_handle,
        "stats_sidecar_status",
        format!("Sidecar: {}", sentence_case(&snapshot.sidecar_status)),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu sidecar failed: {err}"))?;
    let separator = PredefinedMenuItem::separator(app_handle)
        .map_err(|err| format!("tray menu separator failed: {err}"))?;
    let open = MenuItem::with_id(app_handle, "open", "Open Watchtower", true, None::<&str>)
        .map_err(|err| format!("tray menu open failed: {err}"))?;
    let quit = MenuItem::with_id(app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("tray menu quit failed: {err}"))?;

    Menu::with_items(
        app_handle,
        &[
            &active, &runs, &failures, &success, &streak, &sidecar, &separator, &open, &quit,
        ],
    )
    .map_err(|err| format!("tray menu build failed: {err}"))
}

async fn refresh_tray_widget(app_handle: &AppHandle, state: &AppState) -> Result<(), String> {
    let snapshot = query_tray_stats_snapshot(state).await?;
    let menu = build_tray_menu(app_handle, &snapshot)?;
    let tray = app_handle
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not found".to_string())?;

    tray.set_title(Some(format_tray_title(&snapshot)))
        .map_err(|err| format!("tray title update failed: {err}"))?;
    tray.set_tooltip(Some(format_tray_tooltip(&snapshot)))
        .map_err(|err| format!("tray tooltip update failed: {err}"))?;
    tray.set_menu(Some(menu))
        .map_err(|err| format!("tray menu update failed: {err}"))?;

    Ok(())
}

async fn start_tray_refresh_loop(app_handle: AppHandle, state: AppState) {
    let mut interval = tokio::time::interval(TRAY_REFRESH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if state.supervisor_control.is_shutdown_requested() {
            break;
        }

        if let Err(err) = refresh_tray_widget(&app_handle, &state).await {
            eprintln!("failed to refresh tray widget: {err}");
        }
    }
}

fn query_success_streak(connection: &Connection) -> Result<i64, String> {
    let mut stmt = connection
        .prepare("SELECT status FROM jobs ORDER BY updated_at DESC LIMIT 200")
        .map_err(|err| format!("db prepare success streak failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("db query success streak failed: {err}"))?;

    let mut streak = 0i64;
    for row in rows {
        let status = row.map_err(|err| format!("db row success streak failed: {err}"))?;
        if status == "SUCCESS" {
            streak += 1;
        } else {
            break;
        }
    }
    Ok(streak)
}

fn query_channel_heat(connection: &Connection) -> Result<Vec<ChannelHeat>, String> {
    let mut stmt = connection
        .prepare(
            "SELECT
               channel_id,
               COUNT(*) as runs,
               SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failures
             FROM jobs
             WHERE channel_id != ''
               AND julianday(created_at) >= julianday('now', '-7 day')
             GROUP BY channel_id
             ORDER BY runs DESC
             LIMIT 8",
        )
        .map_err(|err| format!("db prepare channel heat failed: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ChannelHeat {
                channel_id: row.get(0)?,
                runs: row.get(1)?,
                failures: row.get(2)?,
            })
        })
        .map_err(|err| format!("db query channel heat failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row channel heat failed: {err}"))?);
    }
    Ok(output)
}

fn query_learning_insights(connection: &Connection) -> Result<LearningInsights, String> {
    let signals_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM learning_signals WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query learning_signals 24h failed: {err}"))?;

    let corrections_learned: i64 = connection
        .query_row("SELECT COUNT(*) FROM intent_corrections", [], |row| {
            row.get(0)
        })
        .map_err(|err| format!("db query intent corrections failed: {err}"))?;

    let corrections_applied_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM learning_signals WHERE correction_applied = 1 AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query correction-applied 24h failed: {err}"))?;

    let personality_profiles: i64 = connection
        .query_row("SELECT COUNT(*) FROM personality_profiles", [], |row| {
            row.get(0)
        })
        .map_err(|err| format!("db query personality profile count failed: {err}"))?;

    let mut mode_stmt = connection
        .prepare(
            "SELECT mode, COUNT(*) as cnt
             FROM personality_profiles
             GROUP BY mode
             ORDER BY cnt DESC, mode ASC
             LIMIT 8",
        )
        .map_err(|err| format!("db prepare personality mode stats failed: {err}"))?;
    let mode_rows = mode_stmt
        .query_map([], |row| {
            Ok(PersonalityModeStats {
                mode: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|err| format!("db query personality mode stats failed: {err}"))?;

    let mut profiles_by_mode = Vec::new();
    for row in mode_rows {
        profiles_by_mode.push(row.map_err(|err| format!("db row personality mode failed: {err}"))?);
    }

    let dominant_personality_mode = profiles_by_mode
        .first()
        .map(|entry| entry.mode.clone())
        .unwrap_or_else(|| "dark_humor".to_string());

    let (top_failure_kind, top_failure_count) = connection
        .query_row(
            "SELECT error_kind, COUNT(*) as cnt
             FROM learning_signals
             WHERE error_kind IS NOT NULL AND error_kind != ''
             GROUP BY error_kind
             ORDER BY cnt DESC, error_kind ASC
             LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|err| format!("db query failure doctor stats failed: {err}"))?
        .unwrap_or_else(|| ("none".to_string(), 0));

    Ok(LearningInsights {
        signals_24h,
        corrections_learned,
        corrections_applied_24h,
        personality_profiles,
        dominant_personality_mode,
        top_failure_kind,
        top_failure_count,
        profiles_by_mode,
    })
}

fn build_recommendations(
    metrics: &DashboardMetrics,
    channel_heat: &[ChannelHeat],
) -> Vec<DashboardRecommendation> {
    let mut recommendations = Vec::new();

    if metrics.failed_runs_24h >= 5 {
        recommendations.push(DashboardRecommendation {
            id: "stability-drill".to_string(),
            priority: "HIGH".to_string(),
            title: "Run a stability drill".to_string(),
            detail: format!(
                "{} failed runs in the last 24h. Prioritize failure triage before new automations.",
                metrics.failed_runs_24h
            ),
        });
    }

    if metrics.unknown_tasks_24h >= 4 {
        recommendations.push(DashboardRecommendation {
            id: "intent-gap".to_string(),
            priority: "MEDIUM".to_string(),
            title: "Teach Watchtower new intents".to_string(),
            detail: format!(
                "{} unknown requests in 24h. Add one workflow route to reduce manual replies.",
                metrics.unknown_tasks_24h
            ),
        });
    }

    if metrics.catchup_recovered_24h > 0 {
        recommendations.push(DashboardRecommendation {
            id: "catchup-win".to_string(),
            priority: "LOW".to_string(),
            title: "Sleep recovery is paying off".to_string(),
            detail: format!(
                "Recovered {} missed mentions after wake/relaunch in the last 24h.",
                metrics.catchup_recovered_24h
            ),
        });
    }

    if metrics.success_streak >= 10 {
        recommendations.push(DashboardRecommendation {
            id: "streak".to_string(),
            priority: "LOW".to_string(),
            title: "Hot streak detected".to_string(),
            detail: format!(
                "{} successful jobs in a row. Good time to raise max concurrency slightly.",
                metrics.success_streak
            ),
        });
    }

    if let Some(hottest) = channel_heat.first() {
        if hottest.failures >= 3 {
            recommendations.push(DashboardRecommendation {
                id: "channel-hotspot".to_string(),
                priority: "MEDIUM".to_string(),
                title: "Channel hotspot".to_string(),
                detail: format!(
                    "Channel {} has {} failures this week. Consider channel-specific prompts/guardrails.",
                    hottest.channel_id, hottest.failures
                ),
            });
        }
    }

    if recommendations.is_empty() {
        recommendations.push(DashboardRecommendation {
            id: "steady".to_string(),
            priority: "LOW".to_string(),
            title: "System healthy".to_string(),
            detail: "No urgent optimization needed. Keep iterating on workflow coverage and response quality."
                .to_string(),
        });
    }

    recommendations
}

fn initialize_db(path: &PathBuf) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|err| format!("db open failed: {err}"))?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              event_id TEXT NOT NULL,
              dedupe_key TEXT NOT NULL,
              workflow TEXT NOT NULL,
              status TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              thread_ts TEXT NOT NULL,
              payload_json TEXT,
              result_json TEXT,
              error_message TEXT,
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_event_id ON jobs(event_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs(dedupe_key);

            CREATE TABLE IF NOT EXISTS job_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              level TEXT NOT NULL,
              stage TEXT NOT NULL,
              message TEXT NOT NULL,
              data_json TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

            CREATE TABLE IF NOT EXISTS events (
              event_id TEXT PRIMARY KEY,
              channel_id TEXT,
              thread_ts TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sidecar_state (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS learning_signals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT,
              event_id TEXT,
              channel_id TEXT,
              user_id TEXT,
              workflow TEXT,
              status TEXT,
              intent TEXT,
              correction_applied INTEGER NOT NULL DEFAULT 0,
              personality_mode TEXT,
              error_kind TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_learning_signals_created_at ON learning_signals(created_at);
            CREATE INDEX IF NOT EXISTS idx_learning_signals_channel_id ON learning_signals(channel_id);

            CREATE TABLE IF NOT EXISTS intent_corrections (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              channel_id TEXT NOT NULL,
              user_id TEXT NOT NULL,
              phrase_key TEXT NOT NULL,
              corrected_intent TEXT NOT NULL,
              hits INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(channel_id, user_id, phrase_key)
            );
            CREATE INDEX IF NOT EXISTS idx_intent_corrections_channel_user ON intent_corrections(channel_id, user_id);

            CREATE TABLE IF NOT EXISTS personality_profiles (
              scope TEXT NOT NULL,
              scope_id TEXT NOT NULL,
              mode TEXT NOT NULL,
              source TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(scope, scope_id)
            );
            CREATE INDEX IF NOT EXISTS idx_personality_profiles_scope ON personality_profiles(scope, scope_id);

            CREATE TABLE IF NOT EXISTS app_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              slack_bot_token TEXT NOT NULL DEFAULT '',
              slack_app_token TEXT NOT NULL DEFAULT '',
              owner_slack_user_ids TEXT NOT NULL DEFAULT '',
              bot_user_id TEXT NOT NULL DEFAULT '',
              bugs_and_updates_channel_id TEXT NOT NULL DEFAULT 'C01H25RNLJH',
              newton_web_path TEXT NOT NULL DEFAULT '',
              newton_api_path TEXT NOT NULL DEFAULT '',
              max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
              pr_review_timeout_ms INTEGER NOT NULL DEFAULT 720000,
              bug_fix_timeout_ms INTEGER NOT NULL DEFAULT 2700000,
              repo_classifier_threshold REAL NOT NULL DEFAULT 0.75,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT OR IGNORE INTO app_settings(id) VALUES(1);
          ",
        )
        .map_err(|err| format!("db migration failed: {err}"))?;

    Ok(())
}

fn read_app_settings(connection: &Connection) -> Result<AppSettings, String> {
    let mut stmt = connection
        .prepare(
            "SELECT
              slack_bot_token,
              slack_app_token,
              owner_slack_user_ids,
              bot_user_id,
              bugs_and_updates_channel_id,
              newton_web_path,
              newton_api_path,
              max_concurrent_jobs,
              pr_review_timeout_ms,
              bug_fix_timeout_ms,
              repo_classifier_threshold
             FROM app_settings
             WHERE id = 1
             LIMIT 1",
        )
        .map_err(|err| format!("db prepare settings failed: {err}"))?;

    let settings = stmt
        .query_row([], |row| {
            Ok(AppSettings {
                slack_bot_token: row.get(0)?,
                slack_app_token: row.get(1)?,
                owner_slack_user_ids: row.get(2)?,
                bot_user_id: row.get(3)?,
                bugs_and_updates_channel_id: row.get(4)?,
                newton_web_path: row.get(5)?,
                newton_api_path: row.get(6)?,
                max_concurrent_jobs: row.get(7)?,
                pr_review_timeout_ms: row.get(8)?,
                bug_fix_timeout_ms: row.get(9)?,
                repo_classifier_threshold: row.get(10)?,
            })
        })
        .optional()
        .map_err(|err| format!("db read settings failed: {err}"))?
        .unwrap_or_default();

    Ok(settings)
}

fn persist_app_settings(connection: &Connection, settings: &AppSettings) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO app_settings(
              id,
              slack_bot_token,
              slack_app_token,
              owner_slack_user_ids,
              bot_user_id,
              bugs_and_updates_channel_id,
              newton_web_path,
              newton_api_path,
              max_concurrent_jobs,
              pr_review_timeout_ms,
              bug_fix_timeout_ms,
              repo_classifier_threshold,
              updated_at
             ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
              slack_bot_token=excluded.slack_bot_token,
              slack_app_token=excluded.slack_app_token,
              owner_slack_user_ids=excluded.owner_slack_user_ids,
              bot_user_id=excluded.bot_user_id,
              bugs_and_updates_channel_id=excluded.bugs_and_updates_channel_id,
              newton_web_path=excluded.newton_web_path,
              newton_api_path=excluded.newton_api_path,
              max_concurrent_jobs=excluded.max_concurrent_jobs,
              pr_review_timeout_ms=excluded.pr_review_timeout_ms,
              bug_fix_timeout_ms=excluded.bug_fix_timeout_ms,
              repo_classifier_threshold=excluded.repo_classifier_threshold,
              updated_at=excluded.updated_at",
            params![
                settings.slack_bot_token.trim(),
                settings.slack_app_token.trim(),
                settings.owner_slack_user_ids.trim(),
                settings.bot_user_id.trim(),
                settings.bugs_and_updates_channel_id.trim(),
                settings.newton_web_path.trim(),
                settings.newton_api_path.trim(),
                settings.max_concurrent_jobs,
                settings.pr_review_timeout_ms,
                settings.bug_fix_timeout_ms,
                settings.repo_classifier_threshold,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|err| format!("db save settings failed: {err}"))?;

    Ok(())
}

fn validate_settings_for_save(settings: &AppSettings) -> Result<(), String> {
    if settings.max_concurrent_jobs < 1 || settings.max_concurrent_jobs > 10 {
        return Err("maxConcurrentJobs must be between 1 and 10".to_string());
    }

    if settings.pr_review_timeout_ms <= 0 {
        return Err("prReviewTimeoutMs must be > 0".to_string());
    }

    if settings.bug_fix_timeout_ms <= 0 {
        return Err("bugFixTimeoutMs must be > 0".to_string());
    }

    if !(0.0..=1.0).contains(&settings.repo_classifier_threshold) {
        return Err("repoClassifierThreshold must be between 0 and 1".to_string());
    }

    validate_optional_path(&settings.newton_web_path, "newtonWebPath")?;
    validate_optional_path(&settings.newton_api_path, "newtonApiPath")?;

    Ok(())
}

fn validate_optional_path(path_value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = path_value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(format!("{field_name} must be an absolute path"));
    }

    if !path.is_dir() {
        return Err(format!("{field_name} must point to an existing directory"));
    }

    Ok(())
}

fn has_owner_ids(raw: &str) -> bool {
    raw.split(',').any(|value| !value.trim().is_empty())
}

fn has_channel_ids(raw: &str) -> bool {
    raw.split(',').any(|value| !value.trim().is_empty())
}

fn is_absolute_directory(path_value: &str) -> bool {
    let path = Path::new(path_value.trim());
    path.is_absolute() && path.is_dir()
}

fn is_settings_complete(settings: &AppSettings) -> bool {
    !settings.slack_bot_token.trim().is_empty()
        && !settings.slack_app_token.trim().is_empty()
        && !settings.bot_user_id.trim().is_empty()
        && has_owner_ids(&settings.owner_slack_user_ids)
        && has_channel_ids(&settings.bugs_and_updates_channel_id)
        && is_absolute_directory(&settings.newton_web_path)
        && is_absolute_directory(&settings.newton_api_path)
}

fn settings_ready(db_path: &PathBuf) -> Result<bool, String> {
    let connection = Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
    let settings = read_app_settings(&connection)?;
    Ok(is_settings_complete(&settings))
}

fn setup_tray(app_handle: AppHandle) -> Result<(), String> {
    let loading = MenuItem::with_id(
        &app_handle,
        "stats_loading",
        "Loading Watchtower status...",
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu loading failed: {err}"))?;
    let separator = PredefinedMenuItem::separator(&app_handle)
        .map_err(|err| format!("tray menu separator failed: {err}"))?;
    let open = MenuItem::with_id(&app_handle, "open", "Open Watchtower", true, None::<&str>)
        .map_err(|err| format!("tray menu open failed: {err}"))?;
    let quit = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("tray menu quit failed: {err}"))?;
    let menu = Menu::with_items(&app_handle, &[&loading, &separator, &open, &quit])
        .map_err(|err| format!("tray menu build failed: {err}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .title("WT starting")
        .tooltip("Watchtower is starting")
        .icon_as_template(true)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                shutdown_sidecar_for_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(&app_handle)
        .map_err(|err| format!("tray init failed: {err}"))?;

    Ok(())
}

async fn set_autostart_enabled(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if !autostart
        .is_enabled()
        .map_err(|err| format!("autostart status failed: {err}"))?
    {
        autostart
            .enable()
            .map_err(|err| format!("autostart enable failed: {err}"))?;
    }
    Ok(())
}

async fn start_sidecar_supervisor(
    app: AppHandle,
    db_path: PathBuf,
    status: SupervisorStatus,
    control: SupervisorControl,
) {
    let mut crash_window: VecDeque<Instant> = VecDeque::new();
    let mut restart_attempt = 0usize;

    loop {
        if control.is_shutdown_requested() {
            status.set("stopped (app shutdown)").await;
            break;
        }

        match settings_ready(&db_path) {
            Ok(true) => {}
            Ok(false) => {
                status
                    .set("waiting for settings (configure Watchtower > Settings)")
                    .await;
                if sleep_with_shutdown_check(&control, Duration::from_secs(5)).await {
                    status.set("stopped (app shutdown)").await;
                    break;
                }
                continue;
            }
            Err(err) => {
                status.set(format!("settings error ({err})")).await;
                if sleep_with_shutdown_check(&control, Duration::from_secs(5)).await {
                    status.set("stopped (app shutdown)").await;
                    break;
                }
                continue;
            }
        }

        let spawn_result = spawn_sidecar_once(&app, &db_path, &status, &control).await;
        if control.is_shutdown_requested() {
            status.set("stopped (app shutdown)").await;
            break;
        }
        match spawn_result {
            Ok(exit_code) => {
                status
                    .set(format!("stopped (exit code {})", exit_code.unwrap_or(-1)))
                    .await;
            }
            Err(err) => {
                status.set(format!("error ({err})")).await;
                emit_notification(
                    &app,
                    "Watchtower sidecar failed",
                    &format!("Sidecar process error: {err}"),
                );
            }
        }

        let now = Instant::now();
        crash_window.push_back(now);
        while let Some(front) = crash_window.front() {
            if now.duration_since(*front) > Duration::from_secs(300) {
                let _ = crash_window.pop_front();
            } else {
                break;
            }
        }

        if crash_window.len() >= 5 {
            status.set("failed (crash loop)").await;
            emit_notification(
                &app,
                "Watchtower crash loop",
                "Sidecar exited repeatedly (5+ crashes in 5 minutes).",
            );
            if sleep_with_shutdown_check(&control, Duration::from_secs(60)).await {
                status.set("stopped (app shutdown)").await;
                break;
            }
        }

        restart_attempt += 1;
        let backoff_secs = match restart_attempt {
            0..=1 => 1,
            2 => 5,
            3 => 15,
            _ => 30,
        };
        status.set(format!("restarting in {}s", backoff_secs)).await;
        if sleep_with_shutdown_check(&control, Duration::from_secs(backoff_secs)).await {
            status.set("stopped (app shutdown)").await;
            break;
        }
    }
}

async fn spawn_sidecar_once(
    app: &AppHandle,
    db_path: &PathBuf,
    status: &SupervisorStatus,
    control: &SupervisorControl,
) -> Result<Option<i32>, String> {
    let sidecar_root = resolve_sidecar_root(app)?;
    let dist_entry = sidecar_root.join("dist/index.js");
    let src_entry = sidecar_root.join("src/index.ts");
    let node_bin = resolve_node_binary(&sidecar_root)?;
    let (entry, use_tsx) = if fs::metadata(&dist_entry).is_ok() {
        (dist_entry, false)
    } else {
        (src_entry, true)
    };

    status.set("starting").await;

    let mut command = Command::new(node_bin);
    if use_tsx {
        command.arg("--import").arg("tsx");
    }

    let mut child = command
        .arg(entry)
        .current_dir(sidecar_root)
        .env("WATCHTOWER_DB_PATH", db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn sidecar: {err}"))?;
    control.set_sidecar_pid(child.id());

    status.set("running").await;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_sidecar_line(&app_clone, &line);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_sidecar_line(&app_clone, &line);
            }
        });
    }

    let status_result = child.wait().await;
    control.clear_sidecar_pid();
    let status_result = status_result.map_err(|err| format!("failed waiting sidecar: {err}"))?;

    Ok(status_result.code())
}

fn shutdown_sidecar_for_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.supervisor_control.request_shutdown();
        if let Err(err) = state.supervisor_control.terminate_sidecar() {
            eprintln!("failed to terminate sidecar during app exit: {err}");
        }
    }
}

async fn sleep_with_shutdown_check(control: &SupervisorControl, duration: Duration) -> bool {
    if duration.is_zero() {
        return control.is_shutdown_requested();
    }

    let mut remaining = duration;
    while remaining > Duration::from_secs(0) {
        if control.is_shutdown_requested() {
            return true;
        }

        let step = remaining.min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
        remaining = remaining.saturating_sub(step);
    }
    control.is_shutdown_requested()
}

fn resolve_sidecar_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("_up_").join("sidecar"));
        candidates.push(resource_dir.join("sidecar"));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(contents_dir) = current_exe
            .parent()
            .and_then(|macos_dir| macos_dir.parent())
        {
            candidates.push(contents_dir.join("Resources").join("_up_").join("sidecar"));
            candidates.push(contents_dir.join("Resources").join("sidecar"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("sidecar"));
        candidates.push(cwd.join("sidecar"));
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to resolve cargo manifest parent".to_string())?;
    candidates.push(manifest_root.join("sidecar"));

    for candidate in candidates {
        if fs::metadata(candidate.join("dist/index.js")).is_ok()
            || fs::metadata(candidate.join("src/index.ts")).is_ok()
        {
            return Ok(candidate);
        }
    }

    Err("failed to resolve sidecar directory (checked bundled resources and local development paths)".to_string())
}

fn resolve_node_binary(sidecar_root: &Path) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(override_node) = std::env::var("NODE_BIN") {
        let trimmed = override_node.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_absolute() {
                candidates.push(candidate);
            } else if let Some(in_path) = find_in_path(trimmed) {
                candidates.push(in_path);
            }
        }
    }

    if let Some(in_path) = find_in_path("node") {
        candidates.push(in_path);
    }

    if let Ok(home) = std::env::var("HOME") {
        let nvm_root = PathBuf::from(home).join(".nvm/versions/node");
        candidates.extend(find_nvm_nodes_descending(&nvm_root));
    }

    let absolute_candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/usr/bin/node",
    ];
    for candidate in absolute_candidates {
        candidates.push(PathBuf::from(candidate));
    }

    let mut seen = std::collections::HashSet::new();
    let mut existing_candidates: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if fs::metadata(&candidate).is_ok() {
            existing_candidates.push(candidate);
        }
    }

    for candidate in &existing_candidates {
        if node_compatible_with_sidecar(candidate, sidecar_root) {
            return Ok(candidate.clone());
        }
    }

    if let Some(fallback) = existing_candidates.into_iter().next() {
        return Ok(fallback);
    }

    Err(
        "node runtime not found; install node or set NODE_BIN to an absolute node binary path"
            .to_string(),
    )
}

fn find_in_path(executable: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let full = dir.join(executable);
        if fs::metadata(&full).is_ok() {
            return Some(full);
        }
    }
    None
}

fn find_nvm_nodes_descending(root: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<String> = match fs::read_dir(root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with('v'))
            .collect(),
        Err(_) => return Vec::new(),
    };

    versions.sort();
    versions.reverse();

    let mut nodes = Vec::new();
    for version in versions {
        let candidate = root.join(version).join("bin/node");
        if fs::metadata(&candidate).is_ok() {
            nodes.push(candidate);
        }
    }

    nodes
}

fn node_compatible_with_sidecar(node_binary: &Path, sidecar_root: &Path) -> bool {
    let mut cmd = std::process::Command::new(node_binary);
    cmd.arg("-e").arg("try { const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('select 1').get(); db.close(); process.exit(0); } catch (_) { process.exit(1); }");
    cmd.current_dir(sidecar_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.status().map(|status| status.success()).unwrap_or(false)
}

fn handle_sidecar_line(app: &AppHandle, line: &str) {
    if let Some(payload) = line.strip_prefix("WATCHTOWER_NOTIFY::") {
        let parsed: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        let title = parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Watchtower");
        let body = parsed
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("Event");
        emit_notification(app, title, body);
        return;
    }

    let _ = app.emit("sidecar-log", line.to_string());
}

fn emit_notification(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
