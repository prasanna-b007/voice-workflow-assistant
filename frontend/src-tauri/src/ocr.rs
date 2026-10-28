//! Reads the text in an image with the OCR engine built into Windows
//! (Windows.Media.Ocr): offline, free, and nothing to download.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

fn win(e: windows::core::Error) -> String {
    format!("Windows OCR failed: {}", e.message())
}

/// The user's display languages first, so non-English screens read correctly;
/// English if none of them has OCR support installed.
fn create_engine() -> Result<OcrEngine, String> {
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        return Ok(engine);
    }
    Language::CreateLanguage(&HSTRING::from("en-US"))
        .and_then(|language| OcrEngine::TryCreateFromLanguage(&language))
        .map_err(|_| {
            "Windows OCR isn't available. Add English in Settings > Time & language > Language & region."
                .to_string()
        })
}

/// Returns the text in a Base64-encoded image, one recognised line per line.
/// Blocks until recognition finishes, so call it off the main thread.
pub fn read_text(image_base64: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(image_base64)
        .map_err(|e| format!("Invalid image data: {}", e))?;
    let mut image =
        image::load_from_memory(&bytes).map_err(|e| format!("Could not decode image: {}", e))?;

    // WinRT needs an apartment on this thread. The error only means one is already set.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let engine = create_engine()?;

    // The engine rejects images larger than this (2600 px), e.g. 4K screenshots.
    let max = OcrEngine::MaxImageDimension().map_err(win)?;
    if image.width() > max || image.height() > max {
        image = image.resize(max, max, image::imageops::FilterType::Triangle);
    }

    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut bgra = rgba.into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let writer = DataWriter::new().map_err(win)?;
    writer.WriteBytes(&bgra).map_err(win)?;
    let buffer = writer.DetachBuffer().map_err(win)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .map_err(win)?;

    let result = engine.RecognizeAsync(&bitmap).map_err(win)?.get().map_err(win)?;
    let lines = result.Lines().map_err(win)?;

    let mut text = String::new();
    for i in 0..lines.Size().map_err(win)? {
        let line = lines.GetAt(i).map_err(win)?;
        text.push_str(&line.Text().map_err(win)?.to_string_lossy());
        text.push('\n');
    }
    Ok(text.trim_end().to_string())
}
