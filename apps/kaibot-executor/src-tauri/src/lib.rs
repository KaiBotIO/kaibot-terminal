use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    AppHandle,
    Manager,
    State,
    tray::TrayIconBuilder,
    menu::{MenuBuilder, MenuItem},
    image::Image,
    WebviewUrl,
    WebviewWindowBuilder,
};

// macOS-only export in tauri v2; an unconditional import breaks the Linux build.
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

/// The node-backend child sidecar. `None` once it has been reaped (clean
/// shutdown) or before it has been started. The watchdog and the
/// `get_backend_status` command both read through this, and every exit path
/// kills through it, so it is the single source of truth for the child handle.
struct BackendProcess(Mutex<Option<Child>>);

/// How many times the watchdog will respawn a sidecar that dies unexpectedly
/// before it gives up and surfaces a hard error instead of fork-bombing a
/// crash-looping binary.
const MAX_BACKEND_RESTARTS: u32 = 5;

#[tauri::command]
fn get_backend_status(state: State<'_, BackendProcess>) -> String {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return "Backend status unavailable (lock poisoned)".to_string(),
    };
    match guard.as_mut() {
        None => "Backend not running".to_string(),
        Some(child) => match child.try_wait() {
            Ok(None) => "Backend is running".to_string(),
            Ok(Some(status)) => match status.code() {
                Some(code) => format!("Backend stopped (exit code {})", code),
                None => "Backend stopped (terminated by signal)".to_string(),
            },
            Err(e) => format!("Backend status unknown ({})", e),
        },
    }
}

/// Directory where the node-backend keeps its desktop-mode state
/// (`~/.kaibot/executor`). We co-locate the sidecar logs here so a
/// crash-looping daemon is diagnosable next to its port file.
fn kaibot_executor_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(
        std::path::PathBuf::from(home)
            .join(".kaibot")
            .join("executor"),
    )
}

/// Stdout/stderr destination for the sidecar. Prefer a log file under the
/// executor data dir so a crash-looping daemon leaves a trace; fall back to
/// inheriting our own stdio if the file can't be opened (never /dev/null).
fn sidecar_stdio() -> (Stdio, Stdio) {
    if let Some(dir) = kaibot_executor_dir() {
        let logs = dir.join("logs");
        if std::fs::create_dir_all(&logs).is_ok() {
            let path = logs.join("node-backend.log");
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                if let Ok(err_clone) = file.try_clone() {
                    return (Stdio::from(file), Stdio::from(err_clone));
                }
                return (Stdio::from(file), Stdio::inherit());
            }
        }
    }
    eprintln!("Could not open sidecar log file; inheriting stdio");
    (Stdio::inherit(), Stdio::inherit())
}

/// Start the node-backend.
///
/// Dev (`tauri dev` / debug builds): spawn `bun run src/main.ts` from the
/// node-backend source tree, exactly as before, so hot-reload-friendly local
/// development is unchanged.
///
/// Production (release bundle): run the compiled sidecar. `build:backend`
/// (`bun build --compile`) produces a self-contained binary that the Tauri
/// bundler ships as an `externalBin` next to the app executable. We resolve it
/// relative to the current executable and spawn it directly, so the existing
/// `std::process::Child` kill-on-quit logic keeps working unchanged.
fn start_backend(app: &AppHandle) -> Result<Child, std::io::Error> {
    std::env::set_var("TAURI", "1");

    let (out, err) = sidecar_stdio();

    if cfg!(debug_assertions) {
        return Command::new("bun")
            .current_dir("../node-backend")
            .arg("run")
            .arg("src/main.ts")
            .stdout(out)
            .stderr(err)
            .spawn();
    }

    // Production: the daemon serves the web UI itself, so point it at the
    // bundled `dist` (shipped via bundle.resources) and let it host one UI for
    // the webview and any browser alike.
    if let Ok(resource_dir) = app.path().resource_dir() {
        std::env::set_var("KAIBOT_STATIC_DIR", resource_dir.join("dist"));
    }

    // Production: the externalBin sidecar is copied beside the app executable.
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no executable dir"))?;
    let sidecar = if cfg!(target_os = "windows") {
        dir.join("node-backend.exe")
    } else {
        dir.join("node-backend")
    };

    // Release builds run the backend in production mode so its env-dependent
    // hardening (storage/crypto.ts secret gate) actually engages.
    Command::new(sidecar)
        .env("NODE_ENV", "production")
        .stdout(out)
        .stderr(err)
        .spawn()
}

/// Kill and reap the sidecar child, if any. Safe to call from any exit path
/// (tray Quit, window close that triggers app exit, Cmd-Q / RunEvent::Exit).
/// Idempotent: once the child is taken, later calls are no-ops.
fn kill_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                // Reap so we don't leave a zombie if the OS is slow to clean up.
                let _ = child.wait();
            }
        }
    }
}

/// Path where the desktop daemon publishes its bound port. Mirrors the
/// `portFile` the node-backend writes in desktop mode.
fn desktop_port_file() -> Option<std::path::PathBuf> {
    kaibot_executor_dir().map(|d| d.join("desktop.port"))
}

/// Read the daemon's currently-published port, falling back to the 9100 the
/// daemon starts its scan from until the port file appears.
fn current_backend_port() -> u16 {
    desktop_port_file()
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(9100)
}

/// Surface a fatal "backend unavailable" state in the webview itself so the
/// user sees a message instead of a blank/stuck splash, plus a log line and an
/// OS attention request. Kept dependency-free (no dialog plugin) by rendering
/// an inline data: URL.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn surface_backend_error(window: &tauri::WebviewWindow, detail: &str) {
    eprintln!("Backend unavailable: {}", detail);
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    let html = format!(
        "<html><body style='background:#0b0d12;color:#e6e6e6;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'><div><h2 style='color:#d4af37'>KaiBot Terminal</h2><p>The trading engine could not be reached.</p><p style='opacity:.6;font-size:13px'>{}</p><p style='opacity:.6;font-size:13px'>Check the logs at ~/.kaibot/executor/logs/node-backend.log and restart the app.</p></div></body></html>",
        detail
    );
    if let Ok(url) = format!("data:text/html;charset=utf-8,{}", urlencode(&html)).parse() {
        let _ = window.navigate(url);
    }
}

/// Minimal percent-encoding for the inline error page (avoids a url-crate dep).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Poll until the daemon is accepting connections, then navigate the webview to
/// the daemon-served UI. The daemon discovers a free port from 9100 and writes
/// it to the port file; we fall back to 9100 until the file appears. If the
/// daemon never comes up within the budget, surface an error in the webview
/// instead of leaving a silent blank splash.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn navigate_when_ready(window: tauri::WebviewWindow) {
    for _ in 0..150 {
        let port = current_backend_port();

        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_ok()
        {
            if let Ok(url) = format!("http://localhost:{}/", port).parse() {
                let _ = window.navigate(url);
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    surface_backend_error(
        &window,
        "The engine did not start listening in time (timed out).",
    );
}

/// Background watchdog: once per interval, check whether the sidecar is still
/// alive. If it exited unexpectedly, log it and respawn (bounded by
/// MAX_BACKEND_RESTARTS); if it keeps dying, surface a hard error in the
/// webview instead of leaving the user on a stale/blank UI.
fn spawn_backend_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let mut restarts: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(5));

            let Some(state) = app.try_state::<BackendProcess>() else {
                // State gone (app tearing down) — nothing to watch.
                return;
            };

            // Determine liveness without holding the lock across the respawn.
            let exited = {
                let Ok(mut guard) = state.0.lock() else { return };
                match guard.as_mut() {
                    // Taken by a shutdown path → we're quitting, stop watching.
                    None => return,
                    Some(child) => match child.try_wait() {
                        Ok(None) => false,                 // still running
                        Ok(Some(_)) | Err(_) => true,      // exited or unknowable
                    },
                }
            };

            if !exited {
                continue;
            }

            if restarts >= MAX_BACKEND_RESTARTS {
                eprintln!(
                    "Backend died and exceeded {} restarts; giving up.",
                    MAX_BACKEND_RESTARTS
                );
                if let Some(win) = app.get_webview_window("main") {
                    surface_backend_error(
                        &win,
                        "The trading engine stopped repeatedly and could not be restarted.",
                    );
                }
                return;
            }

            restarts += 1;
            eprintln!(
                "Backend exited unexpectedly; restarting (attempt {}/{}).",
                restarts, MAX_BACKEND_RESTARTS
            );

            match start_backend(&app) {
                Ok(child) => {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                    // In release the webview may be showing the dead daemon's
                    // (now refused) port; re-point it once the new one is up.
                    #[cfg(not(debug_assertions))]
                    if let Some(win) = app.get_webview_window("main") {
                        let w = win.clone();
                        std::thread::spawn(move || navigate_when_ready(w));
                    }
                }
                Err(e) => {
                    eprintln!("Failed to restart backend: {}", e);
                    if let Some(win) = app.get_webview_window("main") {
                        surface_backend_error(
                            &win,
                            "The trading engine stopped and could not be restarted.",
                        );
                    }
                    return;
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // Desktop-only plugins: signed self-update, relaunch, and login autostart.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    builder
        .setup(|app| {
            // In dev the webview loads the Vite server (devUrl) for HMR. In a
            // release bundle it starts on a bundled loading splash, then
            // navigates to the daemon-served UI once the engine is up — the
            // same UI a browser would load, so there is no native/web fork.
            let initial_url = if cfg!(debug_assertions) {
                WebviewUrl::default()
            } else {
                WebviewUrl::App("loading.html".into())
            };

            // Create the main window with overlay titlebar
            let win_builder = WebviewWindowBuilder::new(app, "main", initial_url)
                .title("KaiBot Terminal")
                .inner_size(1200.0, 800.0)
                .center();

            // macOS: overlay titlebar + transparent window for vibrancy showthrough
            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .title_bar_style(TitleBarStyle::Overlay)
                .transparent(true);

            // A failed window build is fatal — propagate it via the setup
            // Result so it surfaces as an error instead of panicking.
            let window = win_builder.build()?;

            // Apply macOS HudWindow vibrancy (dark frosted glass, Linear-style)
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                ) {
                    eprintln!("Failed to apply vibrancy (unsupported macOS version?): {:?}", e);
                }
            }

            // Start the backend process. A failure to start is surfaced in the
            // webview (instead of a silent blank splash); we still manage an
            // empty slot so the watchdog can attempt a restart.
            match start_backend(app.handle()) {
                Ok(child) => {
                    println!("Backend started successfully");
                    app.manage(BackendProcess(Mutex::new(Some(child))));
                }
                Err(e) => {
                    eprintln!("Failed to start backend: {}", e);
                    app.manage(BackendProcess(Mutex::new(None)));
                    surface_backend_error(
                        &window,
                        &format!("The trading engine failed to start: {}", e),
                    );
                }
            }

            // Watchdog: respawn the sidecar if it dies post-launch, or surface
            // a hard error if it keeps dying — never a silent dead webview.
            spawn_backend_watchdog(app.handle().clone());

            // Release builds: once the daemon is listening, swap the splash for
            // the daemon-served UI. Dev builds already point at Vite.
            #[cfg(not(debug_assertions))]
            {
                let win = window.clone();
                std::thread::spawn(move || navigate_when_ready(win));
            }

            // A trading executor is meant to run 24/7, so launch at login by
            // default. enable() is idempotent; the user can still toggle the
            // login item in their OS settings.
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("Failed to enable autostart: {:?}", e);
                }
            }

            // Create system tray
            // A non-enabled status line at the top, then the actions.
            let status = MenuItem::with_id(app, "status", "KaiBot Terminal", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            // Build menu using MenuBuilder
            let menu = MenuBuilder::new(app)
                .item(&status)
                .separator()
                .item(&open)
                .item(&hide)
                .separator()
                .item(&quit)
                .build()?;

            // Load grayscale icon for macOS
            #[cfg(target_os = "macos")]
            let icon_bytes: &[u8] = include_bytes!("../icons/tray-icon.png");
            #[cfg(not(target_os = "macos"))]
            let icon_bytes: &[u8] = include_bytes!("../icons/32x32.png");

            // A bad icon must not crash startup — degrade to an icon-less tray.
            let icon = match Image::from_bytes(icon_bytes) {
                Ok(img) => Some(img),
                Err(e) => {
                    eprintln!("Failed to load tray icon, using default: {:?}", e);
                    None
                }
            };

            // Create tray with icon (if it loaded)
            let mut tray_builder = TrayIconBuilder::with_id("tray")
                .tooltip("KaiBot Terminal")
                .menu(&menu);

            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);

                // Enable icon template on macOS for proper grayscale rendering
                #[cfg(target_os = "macos")]
                {
                    tray_builder = tray_builder.icon_as_template(true);
                }
            }

            // A failed tray build is fatal — propagate via the setup Result.
            let _tray = tray_builder
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        // Kill backend process before quitting. ExitRequested
                        // below also kills, so this is just the eager path.
                        kill_backend(app);
                        app.exit(0);
                    }
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide window instead of closing (minimize to tray).
                if let Err(e) = window.hide() {
                    eprintln!("Failed to hide window on close: {:?}", e);
                }
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![get_backend_status])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the sidecar on every exit path (Cmd-Q, app.exit, last-window
            // close, OS logout), not just the tray Quit item — otherwise the
            // daemon orphans and keeps trading.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_backend(app);
            }
        });
}
