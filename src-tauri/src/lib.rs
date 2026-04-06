use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::distributions::Alphanumeric;
use rand::{thread_rng, Rng};
use reqwest::blocking::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REDIRECT_PATH: &str = "/callback";

#[derive(Debug, Deserialize)]
struct GoogleTokenSuccess {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenError {
    error: String,
    error_description: Option<String>,
}

fn random_token(length: usize) -> String {
    thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn build_pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn parse_callback_request(request_line: &str) -> Result<Url, String> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or_else(|| "Missing callback method.".to_string())?;
    if method != "GET" {
        return Err("OAuth callback used an unsupported HTTP method.".to_string());
    }
    let raw_path = parts.next().ok_or_else(|| "Missing callback path.".to_string())?;
    Url::parse(&format!("http://127.0.0.1{raw_path}")).map_err(|error| format!("Invalid callback URL: {error}"))
}

fn write_browser_response(stream: &mut std::net::TcpStream, ok: bool, message: &str) -> Result<(), String> {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>303util Google Drive</title></head><body style=\"font-family: sans-serif; background: #171a1e; color: #f1f3f4; display: grid; place-items: center; min-height: 100vh; margin: 0;\"><div style=\"max-width: 420px; padding: 24px; text-align: center;\"><h1 style=\"margin-top: 0;\">{}</h1><p>{}</p><p>You can return to 303util.</p></div></body></html>",
        if ok { "Connected" } else { "Connection failed" },
        message
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("Failed to write browser response: {error}"))
}

fn run_desktop_google_auth(app: &AppHandle, client_id: String, scope: String) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("Failed to start OAuth callback server: {error}"))?;
    listener
        .set_ttl(64)
        .map_err(|error| format!("Failed to configure OAuth callback server: {error}"))?;
    let redirect_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read OAuth callback port: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{redirect_port}{REDIRECT_PATH}");

    let state = random_token(32);
    let verifier = random_token(96);
    let challenge = build_pkce_challenge(&verifier);

    let auth_url = Url::parse_with_params(
        GOOGLE_AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", scope.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|error| format!("Failed to build Google auth URL: {error}"))?;

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|error| format!("Failed to open system browser: {error}"))?;

    listener
        .set_nonblocking(false)
        .map_err(|error| format!("Failed to configure OAuth callback server: {error}"))?;

    let (mut stream, _) = listener
        .accept()
        .map_err(|error| format!("Failed waiting for Google callback: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| format!("Failed to configure OAuth callback timeout: {error}"))?;

    let mut request_line = String::new();
    {
        let mut reader = BufReader::new(&stream);
        reader
            .read_line(&mut request_line)
            .map_err(|error| format!("Failed to read OAuth callback: {error}"))?;
    }

    let callback_url = parse_callback_request(&request_line)?;
    if callback_url.path() != REDIRECT_PATH {
        let _ = write_browser_response(&mut stream, false, "Unexpected OAuth callback path.");
        return Err("Google redirected to an unexpected callback path.".to_string());
    }

    let params: std::collections::HashMap<String, String> = callback_url.query_pairs().into_owned().collect();
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .map(String::as_str)
            .unwrap_or("Google denied the authorization request.");
        let _ = write_browser_response(&mut stream, false, description);
        return Err(format!("Google auth failed: {error} ({description})"));
    }

    let returned_state = params
        .get("state")
        .ok_or_else(|| "Google callback did not include state.".to_string())?;
    if returned_state != &state {
        let _ = write_browser_response(&mut stream, false, "State verification failed.");
        return Err("Google callback state did not match the request.".to_string());
    }

    let code = params
        .get("code")
        .ok_or_else(|| "Google callback did not include an authorization code.".to_string())?;

    let http_client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to create Google token client: {error}"))?;

    let token_response = http_client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .map_err(|error| format!("Failed to exchange Google auth code: {error}"))?;

    if !token_response.status().is_success() {
        let error_payload = token_response
            .json::<GoogleTokenError>()
            .map_err(|error| format!("Google token exchange failed and returned invalid JSON: {error}"))?;
        let description = error_payload
            .error_description
            .unwrap_or_else(|| "Google rejected the token exchange.".to_string());
        let _ = write_browser_response(&mut stream, false, &description);
        return Err(format!("Google token exchange failed: {} ({description})", error_payload.error));
    }

    let success_payload = token_response
        .json::<GoogleTokenSuccess>()
        .map_err(|error| format!("Google token exchange returned invalid JSON: {error}"))?;
    write_browser_response(&mut stream, true, "Google Drive is now connected.")?;
    Ok(success_payload.access_token)
}

#[tauri::command]
async fn desktop_google_drive_access_token(
    app: AppHandle,
    client_id: String,
    scope: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_desktop_google_auth(&app, client_id, scope))
        .await
        .map_err(|error| format!("Desktop Google auth task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop_google_drive_access_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
