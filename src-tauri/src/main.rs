#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod reminders;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
};
use tauri::{utils::config::AppDirectoriesOverride, AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
#[cfg(windows)]
use tauri_plugin_updater::UpdaterExt;

type Waiters = Arc<Mutex<Option<HashMap<u64, Sender<Value>>>>>;

struct Runtime {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    waiters: Waiters,
    sequence: AtomicU64,
}

#[derive(Default)]
struct RuntimeState {
    current: Option<Arc<Runtime>>,
    stopping: bool,
}

#[cfg(windows)]
#[derive(Default)]
struct DesktopUpdateLock(tauri::async_runtime::Mutex<()>);

fn stop_runtime(app: &AppHandle) {
    let state = app.state::<Mutex<RuntimeState>>();
    let runtime = state.lock().ok().and_then(|mut state| {
        state.stopping = true;
        state.current.take()
    });
    if let Some(runtime) = runtime {
        runtime.shutdown();
    }
}

fn read_replies(output: ChildStdout, waiters: Waiters, app: AppHandle) {
    for line in BufReader::new(output).lines() {
        let Ok(line) = line else { break };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        if let Some(event @ ("desktop-chat-turn" | "desktop-service-permissions")) =
            frame["event"].as_str()
        {
            let _ = app.emit(event, &frame["value"]);
            continue;
        }
        let Some(id) = frame["id"].as_u64() else {
            break;
        };
        let Ok(mut pending) = waiters.lock() else {
            break;
        };
        let Some(reply) = pending.as_mut().and_then(|items| items.remove(&id)) else {
            break;
        };
        let _ = reply.send(frame);
    }
    if let Ok(mut pending) = waiters.lock() {
        *pending = None;
    }
}

impl Runtime {
    fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn start_runtime(app: &AppHandle) -> Result<Runtime, String> {
    let root = app.path().resource_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut executable = root.join("node.exe");
    let mut script = root.join("runtime.mjs");
    if cfg!(debug_assertions) {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime");
        executable = dev.join(concat!("node-", env!("OHJINGJING_TARGET"), ".exe"));
        script = dev.join("runtime.mjs");
    }
    let mut command = Command::new(&executable);
    command
        .current_dir(script.parent().ok_or("桌宠运行时路径无效。")?)
        .arg(script.file_name().ok_or("桌宠运行时文件名无效。")?)
        .arg(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let sdk = root.join("dsh-sdk");
    let dsh_runner = root.join("dsh-text-turn.mjs");
    if !cfg!(debug_assertions)
        && env!("OHJINGJING_BUNDLED_DESKTOP_HARNESS") == "1"
        && std::env::var_os("OHJINGJING_DSH_SDK_ROOT").is_none()
        && sdk
            .join("node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js")
            .is_file()
        && dsh_runner.is_file()
    {
        command
            .env("OHJINGJING_DSH_SDK_ROOT", sdk)
            .env("OHJINGJING_DSH_TURN_SCRIPT", dsh_runner)
            .env("OHJINGJING_DSH_NODE", &executable)
            .env("OHJINGJING_DSH_STATE", data.join("dsh-turns"))
            .env("OHJINGJING_DSH_DESKTOP_BUNDLED", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let input = child.stdin.take().ok_or("无法连接桌宠运行时。")?;
    let output = child.stdout.take().ok_or("无法读取桌宠运行时。")?;
    let waiters: Waiters = Arc::new(Mutex::new(Some(HashMap::new())));
    let reader = Arc::clone(&waiters);
    let handle = app.clone();
    std::thread::spawn(move || read_replies(output, reader, handle));
    Ok(Runtime {
        child: Mutex::new(child),
        input: Mutex::new(input),
        waiters,
        sequence: AtomicU64::new(1),
    })
}

fn credential(slot: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("OHJingJing", slot).map_err(|_| "无法打开系统凭据库。".into())
}

fn saved_password(entry: &keyring::Entry) -> Result<Option<String>, DispatchError> {
    match entry.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(DispatchError::Rejected("读取系统凭据失败。".into())),
    }
}

fn key_slot(action: &str, args: &Value) -> Result<Option<String>, String> {
    match action {
        "saveServiceProfile"
        | "removeServiceProfile"
        | "syncWorkspaceSource"
        | "workspaceConversationProfiles"
        | "workspaceDevelopmentTasks"
        | "workspaceDevelopmentAction"
        | "sendWorkspaceReply"
        | "openWorkspaceFeature"
        | "createWorkspaceReviewReminder"
        | "submitWorkspaceDevelopmentTask" => {
            let id = args["id"].as_str().ok_or("缺少服务连接标识。")?;
            if action != "saveServiceProfile" && id == "legacy" {
                return Ok(Some("service".into()));
            }
            if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
                return Err("服务连接标识无效。".into());
            }
            Ok(Some(format!("service-profile:{id}")))
        }
        "groups" | "self" | "member" | "members" | "previewGroupRole" | "followGroupRole"
        | "installGroupRole" | "saveService" | "pushMemory" | "previewMemory" | "applyMemory"
        | "deleteRemoteMemory" | "forkMemoryConflict" | "downloadMemory" => {
            Ok(Some("service".into()))
        }
        "chat"
        | "startChat"
        | "balance"
        | "testModel"
        | "rehearseRole"
        | "extractMemory"
        | "generateInteractionReview"
        | "explainGroupSummary"
        | "explainGroupMember"
        | "explainWorkspace"
        | "clearModelKey"
        | "removeModel"
        | "saveModel" => {
            let key = if action == "saveModel" {
                "id"
            } else {
                "modelId"
            };
            let id = args
                .get(key)
                .and_then(Value::as_str)
                .ok_or("缺少模型 ID。")?;
            if id.is_empty()
                || id.len() > 80
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err("模型 ID 无效。".into());
            }
            Ok(Some(format!("model:{id}")))
        }
        _ => Ok(None),
    }
}

enum DispatchError {
    Transport(String),
    Rejected(String),
}

impl From<DispatchError> for String {
    fn from(error: DispatchError) -> Self {
        match error {
            DispatchError::Transport(message) | DispatchError::Rejected(message) => message,
        }
    }
}

fn dispatch(runtime: &Runtime, mut request: Value) -> Result<Value, DispatchError> {
    let disconnected = || DispatchError::Transport("桌宠运行时连接已断开，重试可重新启动。".into());
    let id = runtime.sequence.fetch_add(1, Ordering::Relaxed);
    request["id"] = json!(id);
    let (reply, response) = mpsc::channel();
    runtime
        .waiters
        .lock()
        .map_err(|_| disconnected())?
        .as_mut()
        .ok_or_else(disconnected)?
        .insert(id, reply);
    let sent = runtime
        .input
        .lock()
        .map_err(|_| disconnected())
        .and_then(|mut input| {
            writeln!(input, "{}", request)
                .and_then(|_| input.flush())
                .map_err(|_| disconnected())
        });
    if let Err(error) = sent {
        if let Ok(mut waiters) = runtime.waiters.lock() {
            *waiters = None;
        }
        return Err(error);
    }
    let frame = response.recv().map_err(|_| disconnected())?;
    match frame["ok"].as_bool() {
        Some(true) => Ok(frame["value"].clone()),
        Some(false) => Err(DispatchError::Rejected(
            frame["error"].as_str().unwrap_or("操作失败。").into(),
        )),
        None => Err(DispatchError::Transport("桌宠运行时响应无效。".into())),
    }
}

fn apply_credential_write(
    staged: Option<(&keyring::Entry, &str)>,
    commit: impl FnOnce() -> Result<Value, DispatchError>,
) -> Result<Value, DispatchError> {
    if let Some((entry, secret)) = staged {
        entry
            .set_password(secret)
            .map_err(|_| DispatchError::Rejected("保存系统凭据失败。".into()))?;
    }
    match commit() {
        Err(error @ DispatchError::Rejected(_)) => {
            if let Some((entry, _)) = staged {
                let _ = entry.delete_credential();
            }
            Err(error)
        }
        // A missing acknowledgement may follow a successful commit. Leave both entries for recovery.
        Err(DispatchError::Transport(_)) => Err(DispatchError::Transport(
            "无法确认保存结果，请刷新桌宠设置后检查。".into(),
        )),
        Ok(output) => Ok(output),
    }
}

fn clean_retired_model_keys(runtime: &Runtime) -> Result<usize, DispatchError> {
    let pending = dispatch(runtime, json!({"action": "pendingModelKeyRemovals"}))?;
    let slots = pending
        .as_array()
        .ok_or_else(|| DispatchError::Transport("桌宠运行时凭据清理记录无效。".into()))?;
    let mut remaining = slots.len();
    for value in slots {
        let Some(slot) = value.as_str().filter(|slot| slot.starts_with("model:")) else {
            continue;
        };
        let Ok(entry) = credential(slot) else {
            continue;
        };
        if matches!(
            entry.delete_credential(),
            Ok(()) | Err(keyring::Error::NoEntry)
        ) {
            dispatch(
                runtime,
                json!({"action": "finishModelKeyRemoval", "args": {"slot": slot}}),
            )?;
            remaining -= 1;
        }
    }
    Ok(remaining)
}

fn dispatch_credential_action(
    runtime: &Runtime,
    action: &str,
    mut args: Value,
    base: &str,
    secret: Option<&str>,
) -> Result<Value, DispatchError> {
    let saving = matches!(action, "saveModel" | "saveService" | "saveServiceProfile");
    let removing_service = action == "removeServiceProfile";
    let new_secret = secret.filter(|value| !value.is_empty());
    let personal_chat = action == "startChat"
        || (action == "chat" && args["context"].as_str().is_none_or(str::is_empty));
    let uses_subscription = matches!(action, "explainGroupSummary" | "explainGroupMember");
    let legacy_service = action == "saveService"
        || (matches!(
            action,
            "removeServiceProfile"
                | "syncWorkspaceSource"
                | "workspaceConversationProfiles"
                | "workspaceDevelopmentTasks"
                | "workspaceDevelopmentAction"
                | "sendWorkspaceReply"
                | "openWorkspaceFeature"
                | "createWorkspaceReviewReminder"
                | "submitWorkspaceDevelopmentTask"
        ) && base == "service");
    let plan = dispatch(
        runtime,
        json!({
            "action": "_credentialPlan",
            "args": { "slot": base, "stage": saving && new_secret.is_some(), "includeBackup": personal_chat,
                "includeSubscription": uses_subscription, "legacyService": legacy_service }
        }),
    )?;
    let binding = &plan["binding"];
    if !binding.is_object() {
        return Err(DispatchError::Transport("桌宠运行时凭据配置无效。".into()));
    }
    if matches!(action, "clearModelKey" | "removeModel") {
        dispatch(
            runtime,
            json!({ "action": action, "args": args, "binding": binding }),
        )?;
        let count = clean_retired_model_keys(runtime)?;
        return Ok(json!({ "pendingModelKeyRemovals": count }));
    }
    let active_slot = binding["slot"].as_str();
    let active_entry = active_slot
        .map(credential)
        .transpose()
        .map_err(DispatchError::Rejected)?;
    if removing_service {
        let output = dispatch(
            runtime,
            json!({ "action": action, "args": args, "binding": binding }),
        )?;
        if let Some(entry) = active_entry {
            let _ = entry.delete_credential();
        }
        return Ok(output);
    }
    let previous = match (&active_entry, secret) {
        (Some(entry), None) => saved_password(entry)?,
        _ => None,
    };
    if !saving {
        let backup = &plan["backup"];
        let spare = backup["binding"]["slot"]
            .as_str()
            .and_then(|slot| credential(slot).ok())
            .and_then(|entry| saved_password(&entry).ok().flatten())
            .map(|key| json!({ "modelId": backup["modelId"], "binding": backup["binding"], "key": key }));
        let subscription = if uses_subscription {
            let binding = &plan["subscriptionBinding"];
            let slot = binding["slot"]
                .as_str()
                .ok_or_else(|| DispatchError::Rejected("请先配置服务地址和订阅令牌。".into()))?;
            let entry = credential(slot).map_err(DispatchError::Rejected)?;
            let key = saved_password(&entry)?;
            Some(json!({ "binding": binding, "key": key }))
        } else {
            None
        };
        let mut workspace = serde_json::Map::new();
        if action == "explainWorkspace" {
            let sources = args["sources"]
                .as_array()
                .filter(|items| !items.is_empty() && items.len() <= 8)
                .ok_or_else(|| DispatchError::Rejected("工作区解读最多可选八个来源。".into()))?;
            for source in sources {
                let id = source
                    .as_str()
                    .ok_or_else(|| DispatchError::Rejected("服务连接标识无效。".into()))?;
                let slot_key = key_slot("syncWorkspaceSource", &json!({ "id": id }))
                    .map_err(DispatchError::Rejected)?;
                let plan = dispatch(
                    runtime,
                    json!({ "action": "_credentialPlan", "args": {
                    "slot": slot_key, "legacyService": id == "legacy"
                } }),
                )?;
                let binding = &plan["binding"];
                if let Some(slot) = binding["slot"].as_str() {
                    let entry = credential(slot).map_err(DispatchError::Rejected)?;
                    let key = saved_password(&entry)?;
                    workspace.insert(id.to_string(), json!({ "binding": binding, "key": key }));
                }
            }
        }
        return dispatch(
            runtime,
            json!({ "action": action, "args": args, "key": previous, "binding": binding, "backup": spare,
                "subscription": subscription, "workspace": workspace }),
        );
    }

    let reusing = previous.is_some();
    let replacement_slot = if new_secret.is_some() {
        Some(
            plan["replacement"]
                .as_str()
                .ok_or_else(|| DispatchError::Transport("桌宠运行时未准备新凭据档案。".into()))?,
        )
    } else {
        active_slot.filter(|_| reusing)
    };
    let staged_entry = replacement_slot
        .filter(|_| new_secret.is_some())
        .map(credential)
        .transpose()
        .map_err(DispatchError::Rejected)?;
    args["reusingKey"] = json!(reusing);
    if action == "saveModel" {
        args["hasKey"] = json!(replacement_slot.is_some());
    }
    let output = apply_credential_write(staged_entry.as_ref().zip(new_secret), || {
        dispatch(
            runtime,
            json!({
                "action": action, "args": args,
                "change": { "expected": binding, "replacement": replacement_slot }
            }),
        )
    })?;
    if active_slot != replacement_slot {
        if let Some(entry) = active_entry {
            let _ = entry.delete_credential();
        }
    }
    Ok(output)
}

#[tauri::command]
async fn run_action(
    app: AppHandle,
    action: String,
    args: Value,
    secret: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if secret.is_some()
            && !matches!(
                action.as_str(),
                "saveModel" | "saveService" | "saveServiceProfile"
            )
        {
            return Err("此操作无法修改凭据。".into());
        }
        let state = app.state::<Mutex<RuntimeState>>();
        let runtime = {
            let mut guard = state.lock().map_err(|_| "桌宠运行时暂不可用。")?;
            if guard.stopping {
                return Err("桌宠正在退出，请稍后再试。".into());
            }
            let open = guard.current.as_ref().is_some_and(|runtime| {
                runtime
                    .waiters
                    .lock()
                    .is_ok_and(|pending| pending.is_some())
            });
            if !open {
                if let Some(previous) = guard.current.take() {
                    previous.shutdown();
                }
                guard.current = Some(Arc::new(start_runtime(&app)?));
            }
            Arc::clone(guard.current.as_ref().unwrap())
        };
        let mut output = match key_slot(&action, &args)? {
            Some(base) => {
                dispatch_credential_action(&runtime, &action, args, &base, secret.as_deref())
            }
            None => dispatch(&runtime, json!({ "action": action, "args": args })),
        };
        if action == "state" {
            output = match output {
                Ok(mut state) if state["pendingModelKeyRemovals"].as_u64().unwrap_or(0) > 0 => {
                    clean_retired_model_keys(&runtime).map(|count| {
                        state["pendingModelKeyRemovals"] = json!(count);
                        state
                    })
                }
                result => result,
            };
        }
        if matches!(&output, Err(DispatchError::Transport(_))) {
            let mut guard = state.lock().map_err(|_| "桌宠运行时暂不可用。")?;
            if guard
                .current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &runtime))
            {
                runtime.shutdown();
                guard.current = None;
            }
        }
        output.map_err(String::from)
    })
    .await
    .map_err(|_| "执行桌宠操作失败。")?
}

#[tauri::command]
async fn save_role_file(
    app: AppHandle,
    window: WebviewWindow,
    role_id: String,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("请从主窗口导出角色。".into());
    }
    let role = run_action(
        app.clone(),
        "exportRole".into(),
        json!({ "roleId": role_id }),
        None,
    )
    .await?;
    let id = role["id"].as_str().ok_or("角色 ID 无效。")?;
    let filename = format!("role-{id}.json");
    let mut data = serde_json::to_vec_pretty(&role).map_err(|_| "角色 JSON 生成失败。")?;
    data.push(b'\n');
    if data.len() > 1_048_576 {
        return Err("角色文件不能超过 1 MiB。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导出角色 JSON")
            .set_file_name(filename)
            .add_filter("角色 JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = selected.into_path().map_err(|_| "选择的文件路径无效。")?;
        if path.extension().is_none() {
            path.set_extension("json");
        }
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("json"))
        {
            return Err("请选择 .json 文件。".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "同名文件已存在，请选择新的文件名。"
                } else {
                    "无法在选定位置创建文件。"
                }
            })?;
        if file.write_all(&data).and_then(|_| file.sync_all()).is_err() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err("角色文件写入失败。".into());
        }
        Ok(true)
    })
    .await
    .map_err(|_| "导出角色失败。")?
}

#[tauri::command]
async fn open_pi_workspace(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("请从主窗口打开 Pi 工作区。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().resource_dir().map_err(|e| e.to_string())?;
        let mut node = root.join("node.exe");
        let mut packages = root.join("pi-cli").join("node_modules");
        if cfg!(debug_assertions) {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            node = dev
                .join("runtime")
                .join(concat!("node-", env!("OHJINGJING_TARGET"), ".exe"));
            packages = dev.join("../pi-workspace/node_modules");
        }
        let cli = packages.join("@earendil-works/pi-coding-agent/dist/bundle/cli.js");
        if !node.is_file() || !cli.is_file() {
            return Err("Pi 工作区组件缺失，请检查桌宠安装包。".into());
        }
        let Some(selected) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("选择 Pi 的工作目录")
            .blocking_pick_folder()
        else {
            return Ok(false);
        };
        let workspace = selected.into_path().map_err(|_| "工作区路径无效。")?;
        if !workspace.is_absolute() || !workspace.is_dir() {
            return Err("请选择本机可访问的工作区文件夹。".into());
        }
        let profile = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("pi-agent");
        let temporary = profile.join("tmp");
        fs::create_dir_all(&temporary).map_err(|_| "无法创建 Pi 工作区数据目录。")?;
        let mut command = Command::new(node);
        command
            .arg(cli)
            .current_dir(workspace)
            .env("PI_CODING_AGENT_DIR", &profile)
            .env("NPM_CONFIG_CACHE", profile.join("npm-cache"))
            .env("TEMP", &temporary)
            .env("TMP", &temporary)
            .env("TMPDIR", &temporary);
        for (name, _) in std::env::vars_os() {
            if name
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("OHJINGJING_")
            {
                command.env_remove(name);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000010);
        }
        command
            .spawn()
            .map_err(|e| format!("无法启动 Pi 工作区：{e}"))?;
        Ok(true)
    })
    .await
    .map_err(|_| "打开 Pi 工作区失败。")?
}

#[tauri::command]
async fn show_main(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("主窗口配置无效。")?;
            tauri::WebviewWindowBuilder::from_config(&app, config)
                .and_then(|builder| builder.build())
                .map_err(|e| e.to_string())?
        }
    };
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn system_defers_reminders() -> bool {
    reminders::system_defers_reminders()
}

#[tauri::command]
async fn check_desktop_update(app: AppHandle) -> Result<Option<Value>, String> {
    #[cfg(windows)]
    {
        if !app.config().plugins.0.contains_key("updater") {
            return Err("桌宠更新渠道尚未配置。".into());
        }
        let updater = app.updater().map_err(|_| "桌宠更新渠道尚未配置。")?;
        let result = updater.check().await.map_err(|error| error.to_string())?;
        Ok(result.map(|update| json!({ "version": update.version, "notes": update.body })))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
async fn install_desktop_update(app: AppHandle, expected_version: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !app.config().plugins.0.contains_key("updater") {
            return Err("桌宠更新渠道尚未配置。".into());
        }
        let update_lock = app.state::<DesktopUpdateLock>();
        let _installing = update_lock.0.try_lock().map_err(|_| "桌宠正在安装更新。")?;
        let before_exit = app.clone();
        let updater = app
            .updater_builder()
            // The Windows updater exits directly after starting the installer.
            .on_before_exit(move || stop_runtime(&before_exit))
            .build()
            .map_err(|_| "桌宠更新渠道尚未配置。")?;
        let update = updater
            .check()
            .await
            .map_err(|error| error.to_string())?
            .ok_or("当前更新已不可用，请重新检查。")?;
        if update.version != expected_version {
            return Err("可用版本发生变化，请重新检查。".into());
        }
        // An installer restart does not preserve a data root supplied by an external launcher.
        let result = update
            .restart_after_install(std::env::var_os("OHJINGJING_DATA_DIR").is_none())
            .download_and_install(|_, _| {}, || {})
            .await;
        if result.is_err() {
            if let Ok(mut runtime) = app.state::<Mutex<RuntimeState>>().lock() {
                runtime.stopping = false;
            }
        }
        result.map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, expected_version);
        Err("此平台暂无桌宠更新渠道。".into())
    }
}

#[tauri::command]
async fn show_pet(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "pet",
        tauri::WebviewUrl::App("index.html?pet=1".into()),
    )
    .title("OHJingJing 桌宠")
    .inner_size(190.0, 150.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn main() {
    let mut context = tauri::generate_context!();
    if let Some(directory) = std::env::var_os("OHJINGJING_DATA_DIR") {
        let directory = PathBuf::from(directory);
        assert!(
            directory.is_absolute(),
            "OHJINGJING_DATA_DIR must be absolute"
        );
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(directory));
    }
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.manage(DesktopUpdateLock::default());
    #[cfg(windows)]
    let builder = if context.config().plugins.0.contains_key("updater") {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(RuntimeState::default()))
        .invoke_handler(tauri::generate_handler![
            run_action,
            save_role_file,
            open_pi_workspace,
            show_pet,
            show_main,
            system_defers_reminders,
            check_desktop_update,
            install_desktop_update
        ])
        .build(context)
        .expect("failed to start OHJingJing")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_runtime(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::{mock::MockCredential, Error};

    #[test]
    fn keyring_write_failure_never_commits_configuration() {
        let mock = MockCredential::default();
        mock.set_error(Error::Invalid("mock write failure".into(), "secret".into()));
        let entry = keyring::Entry::new_with_credential(Box::new(mock));
        let output = apply_credential_write(Some((&entry, "staged")), || {
            panic!("configuration must not commit after the credential write fails")
        });
        assert!(matches!(output, Err(DispatchError::Rejected(_))));
        assert!(matches!(entry.get_password(), Err(Error::NoEntry)));
    }

    #[test]
    fn removes_only_a_staged_credential_with_a_confirmed_rejection() {
        let entry = keyring::Entry::new_with_credential(Box::<MockCredential>::default());
        let output = apply_credential_write(Some((&entry, "rejected")), || {
            assert_eq!(entry.get_password().unwrap(), "rejected");
            Err(DispatchError::Rejected("invalid address".into()))
        });
        assert!(matches!(output, Err(DispatchError::Rejected(_))));
        assert!(matches!(entry.get_password(), Err(Error::NoEntry)));

        let output = apply_credential_write(Some((&entry, "possibly committed")), || {
            Err(DispatchError::Transport("connection closed".into()))
        });
        assert!(matches!(output, Err(DispatchError::Transport(_))));
        assert_eq!(entry.get_password().unwrap(), "possibly committed");
    }
}
