use std::error::Error;
use std::marker::PhantomData;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{plugin::{Builder, PluginApi, TauriPlugin}, AppHandle, Manager, Runtime};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePngRequest {
    file_name: String,
    base64_data: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct SavePngResponse {
    uri: String,
}

pub trait PngExportExt<R: Runtime> {
    fn png_export(&self) -> &PngExport<R>;
}

impl<R: Runtime, T: Manager<R>> PngExportExt<R> for T {
    fn png_export(&self) -> &PngExport<R> {
        self.state::<PngExport<R>>().inner()
    }
}

#[cfg(target_os = "android")]
pub struct PngExport<R: Runtime>(PluginHandle<R>);

#[cfg(not(target_os = "android"))]
pub struct PngExport<R: Runtime>(PhantomData<fn() -> R>);

#[cfg(target_os = "android")]
impl<R: Runtime> PngExport<R> {
    fn save_png(&self, payload: SavePngRequest) -> Result<SavePngResponse, String> {
        self.0
            .run_mobile_plugin("savePng", payload)
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "android"))]
impl<R: Runtime> PngExport<R> {
    fn save_png(&self, _payload: SavePngRequest) -> Result<SavePngResponse, String> {
        Err("PNG export mobile plugin is only available on Android.".to_string())
    }
}

#[cfg(target_os = "android")]
fn init_mobile<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PngExport<R>, Box<dyn Error>> {
    let handle = api
        .register_android_plugin("com.leonardomirabal.a303util", "PngExportPlugin")
        .map_err(|error| -> Box<dyn Error> { Box::new(error) })?;
    Ok(PngExport(handle))
}

#[cfg(not(target_os = "android"))]
fn init_mobile<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PngExport<R>, Box<dyn Error>> {
    Ok(PngExport(PhantomData))
}

#[tauri::command]
fn save_png<R: Runtime>(app: AppHandle<R>, file_name: String, base64_data: String) -> Result<SavePngResponse, String> {
    app.png_export().save_png(SavePngRequest {
        file_name,
        base64_data,
    })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pngExport")
        .invoke_handler(tauri::generate_handler![save_png])
        .setup(|app, api| {
            let png_export = init_mobile(app, api)?;
            app.manage(png_export);
            Ok(())
        })
        .build()
}
