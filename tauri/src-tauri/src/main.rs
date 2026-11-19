// Local Streamer - Tauri edition (Windows and macOS).
// The webview (WebView2 on Windows, WKWebView on macOS) captures the HDMI card
// via getUserMedia and shows it; Rust plays the audio and provides global
// hotkeys, permission auto-grant and window-state persistence.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod discord;

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Replace all global hotkeys. `hotkeys` maps action name -> accelerator
/// (e.g. "Ctrl+Alt+ArrowUp"). Returns human-readable failures.
#[tauri::command]
fn set_hotkeys(app: AppHandle, hotkeys: HashMap<String, String>) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut failed = Vec::new();
    for (action, accel) in hotkeys {
        if accel.trim().is_empty() {
            continue;
        }
        let name = action.clone();
        let res = gs.on_shortcut(accel.as_str(), move |app, _shortcut, ev| {
            if ev.state == ShortcutState::Pressed {
                let _ = app.emit("hotkey", name.clone());
            }
        });
        if let Err(e) = res {
            failed.push(format!("{accel} ({e})"));
        }
    }
    failed
}

/// Auto-allow camera/microphone requests from our own page so there's no
/// prompt on every launch, and turn off browser shortcuts (F5 reload, Ctrl+F...).
/// The page awaits this before calling getUserMedia.
///
/// Only Windows needs work here. On macOS, wry's WKUIDelegate grants the
/// webview's media requests by default; the one-time system prompt (camera /
/// microphone in Privacy & Security) comes from the Info.plist usage strings.
#[tauri::command]
async fn media_ready(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static DONE: AtomicBool = AtomicBool::new(false);
        if DONE.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        window
            .with_webview(move |pw| {
                let r = unsafe { install_permission_handler(&pw) };
                let _ = tx.send(r.map_err(|e| e.to_string()));
            })
            .map_err(|e| e.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = window;
    #[allow(unreachable_code)]
    Ok(())
}

/// True when running on macOS outside an .app bundle (the bare binary from
/// `npm run build`, or `npm run dev`). macOS reads the camera / microphone usage
/// strings from the bundle's Info.plist, so outside a bundle it may block both.
#[tauri::command]
fn unbundled_mac() -> bool {
    cfg!(target_os = "macos")
        && !std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(true)
}

#[cfg(windows)]
unsafe fn install_permission_handler(pw: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;
    use windows_core::Interface;

    let core = pw.controller().CoreWebView2()?;
    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
            {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    core.add_PermissionRequested(&handler, &mut token)?;
    if let Ok(s3) = core.Settings()?.cast::<ICoreWebView2Settings3>() {
        let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
    }
    Ok(())
}

// ------------------------------------------------------------------ audio
// Audio is played from this process (not the webview's helper processes:
// msedgewebview2.exe on Windows, WebKit's WebContent process on macOS) so
// Discord's window share attributes it to this app.

#[tauri::command]
async fn audio_devices() -> audio::DeviceList {
    tauri::async_runtime::spawn_blocking(audio::list_devices)
        .await
        .unwrap_or_else(|_| audio::list_devices())
}

#[tauri::command]
async fn audio_configure(
    engine: State<'_, audio::AudioEngine>,
    game: Option<String>,
    music: Option<String>,
    output: Option<String>,
) -> Result<String, String> {
    engine.configure(game, music, output)
}

#[tauri::command]
fn audio_set_volume(engine: State<'_, audio::AudioEngine>, channel: String, volume: f32, muted: bool) {
    let ch = if channel == "music" { audio::Channel::Music } else { audio::Channel::Game };
    engine.set_volume(ch, volume, muted);
}

#[tauri::command]
fn audio_set_delay(engine: State<'_, audio::AudioEngine>, ms: u32) {
    engine.set_delay(ms);
}

#[tauri::command]
fn audio_stats(engine: State<'_, audio::AudioEngine>) -> audio::StatsSnapshot {
    engine.stats()
}

/// The audio engine's clock, so the page can line beep times up with frame times.
#[tauri::command]
fn audio_clock(engine: State<'_, audio::AudioEngine>) -> f64 {
    engine.clock_ms()
}

#[tauri::command]
fn audio_sync_probe(engine: State<'_, audio::AudioEngine>, on: bool) {
    engine.sync_probe(on);
}

#[tauri::command]
fn audio_sync_onsets(engine: State<'_, audio::AudioEngine>) -> Vec<f64> {
    engine.sync_onsets()
}

// ------------------------------------------------------------------ discord
#[tauri::command]
fn presence_set(
    presence: State<'_, discord::Presence>,
    client_id: String,
    game: String,
    console: String,
    start_ms: i64,
) {
    if client_id.trim().is_empty() || (game.trim().is_empty() && console.trim().is_empty()) {
        presence.clear();
    } else {
        presence.set(client_id.trim().into(), game.trim().into(), console.trim().into(), start_ms);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(audio::AudioEngine::new(Arc::new(move |msg: String| {
                let _ = handle.emit("audio-error", msg);
            })));
            let handle = app.handle().clone();
            app.manage(discord::Presence::new(Box::new(move |msg: String| {
                let _ = handle.emit("presence-status", msg);
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_hotkeys,
            media_ready,
            unbundled_mac,
            audio_devices,
            audio_configure,
            audio_set_volume,
            audio_set_delay,
            audio_stats,
            audio_clock,
            audio_sync_probe,
            audio_sync_onsets,
            presence_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local Streamer");
}
