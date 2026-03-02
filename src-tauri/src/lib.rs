use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime::spawn,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::RwLock,
};

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

#[derive(Clone)]
struct AppState {
    db_path: Arc<PathBuf>,
    supervisor: SupervisorStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    id: String,
    workflow: String,
    status: String,
    channel_id: String,
    thread_ts: String,
    created_at: String,
    updated_at: String,
    error_message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    sidecar_status: String,
    settings_configured: bool,
    active_jobs: Vec<RunSummary>,
    recent_runs: Vec<RunSummary>,
    failures: Vec<RunSummary>,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
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
            let state = AppState {
                db_path: Arc::new(db_path.clone()),
                supervisor: supervisor.clone(),
            };
            app.manage(state.clone());

            setup_tray(app_handle.clone())?;

            let app_handle_for_autostart = app_handle.clone();
            spawn(async move {
                if let Err(err) = set_autostart_enabled(&app_handle_for_autostart).await {
                    eprintln!("failed to enable launch-on-login: {err}");
                }
            });

            spawn(start_sidecar_supervisor(app_handle, db_path, supervisor));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            get_app_settings,
            save_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn get_dashboard_data(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let connection = Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let active_jobs = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message FROM jobs WHERE status = 'RUNNING' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let recent_runs = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message FROM jobs ORDER BY updated_at DESC LIMIT 50",
    )?;
    let failures = query_runs(
        &connection,
        "SELECT id, workflow, status, channel_id, thread_ts, created_at, updated_at, error_message FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 50",
    )?;

    let settings = read_app_settings(&connection)?;

    Ok(DashboardData {
        sidecar_status: state.supervisor.get().await,
        settings_configured: is_settings_complete(&settings),
        active_jobs,
        recent_runs,
        failures,
    })
}

#[tauri::command]
async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let connection = Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    read_app_settings(&connection)
}

#[tauri::command]
async fn save_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<SaveSettingsResponse, String> {
    validate_settings_for_save(&settings)?;

    let connection = Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
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
            Ok(RunSummary {
                id: row.get(0)?,
                workflow: row.get(1)?,
                status: row.get(2)?,
                channel_id: row.get(3)?,
                thread_ts: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                error_message: row.get(7)?,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(output)
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

            CREATE TABLE IF NOT EXISTS events (
              event_id TEXT PRIMARY KEY,
              channel_id TEXT,
              thread_ts TEXT,
              created_at TEXT NOT NULL
            );

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
    let open = MenuItem::with_id(&app_handle, "open", "Open Watchtower", true, None::<&str>)
        .map_err(|err| format!("tray menu open failed: {err}"))?;
    let quit = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("tray menu quit failed: {err}"))?;
    let menu = Menu::with_items(&app_handle, &[&open, &quit])
        .map_err(|err| format!("tray menu build failed: {err}"))?;

    TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
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

async fn start_sidecar_supervisor(app: AppHandle, db_path: PathBuf, status: SupervisorStatus) {
    let mut crash_window: VecDeque<Instant> = VecDeque::new();
    let mut restart_attempt = 0usize;

    loop {
        match settings_ready(&db_path) {
            Ok(true) => {}
            Ok(false) => {
                status
                    .set("waiting for settings (configure Watchtower > Settings)")
                    .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            Err(err) => {
                status.set(format!("settings error ({err})")).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        }

        let spawn_result = spawn_sidecar_once(&app, &db_path, &status).await;
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
            tokio::time::sleep(Duration::from_secs(60)).await;
        }

        restart_attempt += 1;
        let backoff_secs = match restart_attempt {
            0..=1 => 1,
            2 => 5,
            3 => 15,
            _ => 30,
        };
        status
            .set(format!("restarting in {}s", backoff_secs))
            .await;
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
    }
}

async fn spawn_sidecar_once(
    app: &AppHandle,
    db_path: &PathBuf,
    status: &SupervisorStatus,
) -> Result<Option<i32>, String> {
    let sidecar_root = resolve_sidecar_root(app)?;
    let dist_entry = sidecar_root.join("dist/index.js");
    let src_entry = sidecar_root.join("src/index.ts");
    let node_bin = std::env::var("NODE_BIN").unwrap_or_else(|_| "node".to_string());
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

    let status_result = child
        .wait()
        .await
        .map_err(|err| format!("failed waiting sidecar: {err}"))?;

    Ok(status_result.code())
}

fn resolve_sidecar_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to resolve cargo manifest parent".to_string())?;
    candidates.push(manifest_root.join("sidecar"));

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("sidecar"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("sidecar"));
        candidates.push(cwd.join("sidecar"));
    }

    for candidate in candidates {
        if fs::metadata(candidate.join("dist/index.js")).is_ok()
            || fs::metadata(candidate.join("src/index.ts")).is_ok()
        {
            return Ok(candidate);
        }
    }

    Err("failed to resolve sidecar directory".to_string())
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
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}
