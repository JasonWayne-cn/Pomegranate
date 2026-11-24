//! 语音识别（ASR）Command 层。
//!
//! 薄包装：调用 `services::asr::AsrService` 并把 `AppError` 转成 `String`。
//! 对外接口：
//! - `asr_get_config` 读当前配置（首次访问 = 默认值，api_key 为空）
//! - `asr_save_config` 保存配置（启用时强校验 api_key）
//! - `asr_test_connection` 测试连通性（不消耗识别用量）
//! - `asr_transcribe_audio` 把 base64 音频转文字
//! - `asr_correct_text` 识别后术语纠错（只发文本，不发音频）
//! - `asr_list_vocabulary` / `asr_add_vocabulary` / `asr_remove_vocabulary` 词表管理
//! - `asr_local_model_status` / `asr_local_model_download` / `asr_local_model_remove`
//!   本地离线资源（引擎 + SenseVoice Small INT8 模型，均在运行时按需下载）

use crate::models::{
    AsrConfig, AsrCorrectionRequest, AsrCorrectionResult, AsrLocalModelStatus, AsrTestResult,
    AsrVocabularyInput, AsrVocabularyTerm, TranscribeRequest, TranscribeResult,
};
use crate::services::asr::{local_model, AsrService};
use crate::state::AppState;

#[tauri::command]
pub fn asr_get_config(state: tauri::State<'_, AppState>) -> Result<AsrConfig, String> {
    AsrService::get_config(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_save_config(state: tauri::State<'_, AppState>, config: AsrConfig) -> Result<(), String> {
    AsrService::save_config(&state.db, &config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn asr_test_connection(
    state: tauri::State<'_, AppState>,
    config: AsrConfig,
) -> Result<AsrTestResult, String> {
    Ok(AsrService::test_connection(&config, &state.data_dir).await)
}

#[tauri::command]
pub async fn asr_transcribe_audio(
    state: tauri::State<'_, AppState>,
    request: TranscribeRequest,
) -> Result<TranscribeResult, String> {
    AsrService::transcribe(
        &state.db,
        &state.data_dir,
        &request.audio_base64,
        &request.mime,
        request.language.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_local_model_status(
    state: tauri::State<'_, AppState>,
) -> Result<AsrLocalModelStatus, String> {
    Ok(local_model::status(&state.data_dir))
}

/// 下载本地引擎与模型。进度通过 `asr-local:progress` 事件推送。
/// 引擎/模型体积较大（合计约 260MB），前端应提示用户。
#[tauri::command]
pub async fn asr_local_model_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    local_model::download(&app, &state.data_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_local_model_remove(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    local_model::remove(&state.data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn asr_correct_text(
    state: tauri::State<'_, AppState>,
    request: AsrCorrectionRequest,
) -> Result<AsrCorrectionResult, String> {
    AsrService::correct_text(&state.db, &request.text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_list_vocabulary(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AsrVocabularyTerm>, String> {
    AsrService::list_vocabulary(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_add_vocabulary(
    state: tauri::State<'_, AppState>,
    input: AsrVocabularyInput,
) -> Result<i64, String> {
    AsrService::add_vocabulary(&state.db, &input.term, &input.aliases).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_remove_vocabulary(state: tauri::State<'_, AppState>, id: i64) -> Result<bool, String> {
    AsrService::remove_vocabulary(&state.db, id).map_err(|e| e.to_string())
}
