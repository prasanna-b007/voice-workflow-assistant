//! Downloads a large model file with resume and a SHA-256 check. Shared by the
//! Whisper voice model (whisper.rs) and the AI model (ai.rs).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

pub struct ModelFile {
    /// Pinned to a commit so the file can't change under the checksum.
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// Downloads `model` to `dest`, resuming from `dest` + ".part" if an earlier attempt
/// was interrupted. `progress` is called with the bytes downloaded so far, about
/// four times a second.
pub async fn download(model: &ModelFile, dest: &Path, progress: impl Fn(u64)) -> Result<(), String> {
    let part = part_path(dest);
    let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > model.size {
        have = 0;
    }
    log::info!("download: {} ({} of {} bytes already here)", model.url, have, model.size);
    progress(have);

    let failed = |e: reqwest::Error| format!("Download failed: {}. Check your internet connection.", e);
    if have < model.size {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(failed)?;
        let mut request = client.get(model.url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", have));
        }
        let mut response = request.send().await.map_err(failed)?;
        let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !response.status().is_success() {
            return Err(format!("Download failed: the server answered {}.", response.status()));
        }
        if !resumed {
            have = 0;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(|e| format!("Couldn't write {}: {}", part.display(), e))?;
        let mut last_report = Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            file.write_all(&chunk).map_err(|e| format!("Couldn't write {}: {}", part.display(), e))?;
            have += chunk.len() as u64;
            if last_report.elapsed() >= Duration::from_millis(250) {
                last_report = Instant::now();
                progress(have);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
    }
    if have != model.size {
        // Keep the partial file: the next attempt resumes from it.
        return Err("Download was interrupted. It will resume on the next try.".into());
    }

    let check = part.clone();
    let hash = tauri::async_runtime::spawn_blocking(move || sha256(&check)).await.map_err(|e| e.to_string())??;
    if hash != model.sha256 {
        let _ = fs::remove_file(&part);
        return Err("The downloaded model was damaged. Try again to download a fresh copy.".into());
    }
    fs::rename(&part, dest).map_err(|e| format!("Couldn't save {}: {}", dest.display(), e))
}

/// "model.gguf" → "model.gguf.part".
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
