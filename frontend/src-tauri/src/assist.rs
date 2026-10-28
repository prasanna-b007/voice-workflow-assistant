//! Helpers for the assistant commands in src/workflows/assistantActions.js:
//! playing the top YouTube result, listing web results to open after a search,
//! reading news headlines,
//! reading the user's selected text, and checking whether an app (Spotify,
//! WhatsApp) is installed.

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

// Child processes would otherwise flash a console window, and for
// read_selection that window would take focus before Ctrl+C is sent.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The video id of the top YouTube search result, read from the results page so
/// no API key is needed.
#[tauri::command]
pub async fn youtube_first_video(query: String) -> Result<String, String> {
    let url = reqwest::Url::parse_with_params("https://www.youtube.com/results", &[("search_query", &query)])
        .map_err(|e| e.to_string())?;

    let html = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .header("Accept-Language", "en-US,en;q=0.9")
        // Skips the cookie consent page shown in some regions.
        .header("Cookie", "CONSENT=YES+1")
        .send()
        .await
        .map_err(|e| format!("YouTube request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("YouTube returned an unreadable page: {}", e))?;

    // Results are embedded as JSON; "videoRenderer" entries are real videos, not ads or shelves.
    let marker = "\"videoRenderer\":{\"videoId\":\"";
    let start = html.find(marker).ok_or("No video found")? + marker.len();
    let id: String = html[start..].chars().take(11).collect();

    if id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err("No video found".to_string())
    }
}

#[derive(serde::Serialize)]
pub struct SearchResult {
    title: String,
    url: String,
    /// The page extract shown under the title; webAnswer.js answers questions from these.
    snippet: String,
}

/// The top web results for a query, so "open the first result" can follow a
/// Google search. Read from DuckDuckGo's plain-HTML page, which needs no API key
/// (Google's results page blocks this kind of request).
#[tauri::command]
pub async fn search_results(query: String) -> Result<Vec<SearchResult>, String> {
    let url = reqwest::Url::parse_with_params("https://html.duckduckgo.com/html/", &[("q", &query)])
        .map_err(|e| e.to_string())?;

    let html = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Search request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Search returned an unreadable page: {}", e))?;

    // Each result is <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded url>&amp;…">Title</a>.
    // Ads link elsewhere and have no uddg parameter, so they are skipped.
    let mut results = Vec::new();
    for chunk in html.split("class=\"result__a\" href=\"").skip(1) {
        let Some(end) = chunk.find('"') else { continue };
        let Some(encoded) = chunk[..end].split("uddg=").nth(1) else { continue };
        let url = percent_decode(encoded.split("&amp;").next().unwrap_or(encoded));
        if !url.starts_with("http") {
            continue;
        }
        let title = chunk[end..]
            .split_once('>')
            .and_then(|(_, rest)| rest.split('<').next())
            .unwrap_or("");
        // The snippet follows in the same result: <a class="result__snippet" …>text with <b>bold</b></a>.
        let snippet = chunk
            .split_once("class=\"result__snippet\"")
            .and_then(|(_, rest)| rest.split_once('>'))
            .and_then(|(_, rest)| rest.split("</a>").next())
            .map(|html| unescape_html(strip_tags(html).trim()))
            .unwrap_or_default();
        results.push(SearchResult { title: unescape_html(title.trim()), url, snippet });
        if results.len() == 8 {
            break;
        }
    }
    Ok(results)
}

/// The top headlines from Google News's RSS feed (no key needed), for a topic
/// or, when `query` is empty, the front page. `region` is a country code like "IN".
#[tauri::command]
pub async fn news_headlines(query: String, region: String) -> Result<Vec<String>, String> {
    let region = if region.len() == 2 && region.chars().all(|c| c.is_ascii_alphabetic()) { region.to_uppercase() } else { "US".to_string() };
    let ceid = format!("{}:en", region);
    let lang = format!("en-{}", region);
    let params = [("hl", lang.as_str()), ("gl", region.as_str()), ("ceid", ceid.as_str())];
    let url = if query.trim().is_empty() {
        reqwest::Url::parse_with_params("https://news.google.com/rss", &params)
    } else {
        reqwest::Url::parse_with_params("https://news.google.com/rss/search", params.iter().copied().chain([("q", query.as_str())]))
    }
    .map_err(|e| e.to_string())?;

    let xml = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("News request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("News returned an unreadable feed: {}", e))?;

    // Each <item><title> is "Headline - Source"; the source is dropped to keep it short to hear.
    Ok(xml
        .split("<item><title>")
        .skip(1)
        .filter_map(|item| item.split("</title>").next())
        .map(|title| {
            let title = unescape_html(title.trim());
            title.rsplit_once(" - ").map(|(headline, _)| headline.to_string()).unwrap_or(title)
        })
        .filter(|title| !title.is_empty())
        .take(5)
        .collect())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn unescape_html(s: &str) -> String {
    s.replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Copies the text selected in the foreground app and returns it, then puts back
/// whatever was on the clipboard before. Empty when nothing is selected.
#[tauri::command]
pub fn read_selection() -> Result<String, String> {
    let script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
        Add-Type -AssemblyName System.Windows.Forms; \
        $old = Get-Clipboard -Raw; \
        [System.Windows.Forms.Clipboard]::Clear(); \
        (New-Object -ComObject WScript.Shell).SendKeys('^c'); \
        Start-Sleep -Milliseconds 300; \
        $text = Get-Clipboard -Raw; \
        if ($old) { Set-Clipboard -Value $old }; \
        $text";

    let output = Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to read the selection: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Whether an installed app handles links like `spotify:` or `whatsapp:`.
#[tauri::command]
pub fn has_url_handler(scheme: String) -> bool {
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    Command::new("reg")
        .args(["query", &format!("HKCR\\{}", scheme), "/v", "URL Protocol"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
