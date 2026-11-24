//! 语音识别（ASR）服务层。
//!
//! 抽象出统一的入口 `AsrService`，按 `AsrProviderKind` 分发到具体实现。
//! 当前仅一家：阿里云百炼 DashScope（[`dashscope`]）。
//!
//! 配置读写走 `app_config` 表 KV，前缀 `asr.*`，与现有 `ai_models.api_key`
//! 风格一致（明文存储；用户在自己电脑上，且与第三方调用不可避免地共享 Key）。

pub mod correction;
pub mod dashscope;
pub mod local;
pub mod local_model;

use crate::database::Database;
use crate::error::AppError;
use crate::models::{
    AsrConfig, AsrCorrectionResult, AsrProviderKind, AsrTestResult, AsrVocabularyTerm,
    TranscribeResult,
};

pub struct AsrService;

impl AsrService {
    const KEY_PROVIDER: &'static str = "asr.provider";
    const KEY_API_KEY: &'static str = "asr.api_key";
    const KEY_MODEL: &'static str = "asr.model";
    const KEY_REGION: &'static str = "asr.region";
    const KEY_ENABLED: &'static str = "asr.enabled";
    const KEY_CORRECTION_ENABLED: &'static str = "asr.correction_enabled";

    /// 读取当前 ASR 配置。任意字段缺失走 `AsrConfig::default()`。
    pub fn get_config(db: &Database) -> Result<AsrConfig, AppError> {
        let mut cfg = AsrConfig::default();
        if let Some(v) = db.get_config(Self::KEY_PROVIDER)? {
            if let Some(k) = AsrProviderKind::parse(&v) {
                cfg.provider = k;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_API_KEY)? {
            cfg.api_key = v;
        }
        if let Some(v) = db.get_config(Self::KEY_MODEL)? {
            if !v.is_empty() {
                cfg.model = v;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_REGION)? {
            if !v.is_empty() {
                cfg.region = v;
            }
        }
        if let Some(v) = db.get_config(Self::KEY_ENABLED)? {
            cfg.enabled = matches!(v.as_str(), "1" | "true");
        }
        if let Some(v) = db.get_config(Self::KEY_CORRECTION_ENABLED)? {
            cfg.correction_enabled = matches!(v.as_str(), "1" | "true");
        }
        Ok(cfg)
    }

    /// 保存配置；云端 provider 启用时强校验 api_key 非空，避免静默失败。
    /// 本地 provider 不需要 Key（模型资源单独下载）。
    pub fn save_config(db: &Database, cfg: &AsrConfig) -> Result<(), AppError> {
        if cfg.enabled && cfg.provider.requires_api_key() && cfg.api_key.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "启用语音识别前必须填写 API Key".into(),
            ));
        }
        db.set_config(Self::KEY_PROVIDER, cfg.provider.as_str())?;
        db.set_config(Self::KEY_API_KEY, &cfg.api_key)?;
        db.set_config(Self::KEY_MODEL, &cfg.model)?;
        db.set_config(Self::KEY_REGION, &cfg.region)?;
        db.set_config(Self::KEY_ENABLED, if cfg.enabled { "1" } else { "0" })?;
        db.set_config(
            Self::KEY_CORRECTION_ENABLED,
            if cfg.correction_enabled { "1" } else { "0" },
        )?;
        Ok(())
    }

    /// 转录入口：从 DB 读配置 → 校验 → 派发到具体实现。
    ///
    /// `data_dir` 供本地引擎定位已下载的模型/引擎（云端实现不使用）。
    pub async fn transcribe(
        db: &Database,
        data_dir: &std::path::Path,
        audio_b64: &str,
        mime: &str,
        language: Option<&str>,
    ) -> Result<TranscribeResult, AppError> {
        let cfg = Self::get_config(db)?;
        if !cfg.enabled {
            return Err(AppError::InvalidInput("语音识别未启用".into()));
        }
        match cfg.provider {
            AsrProviderKind::Dashscope => {
                if cfg.api_key.trim().is_empty() {
                    return Err(AppError::InvalidInput("尚未配置 API Key".into()));
                }
                dashscope::transcribe(&cfg, audio_b64, mime, language).await
            }
            AsrProviderKind::Local => local::transcribe(data_dir, audio_b64, mime, language).await,
        }
    }

    /// 识别后纠错：未启用或词表为空时原样返回；失败也不影响录入（保留原文）。
    pub async fn correct_text(db: &Database, text: &str) -> Result<AsrCorrectionResult, AppError> {
        let cfg = Self::get_config(db)?;
        let original = text.trim().to_string();
        let (corrected, changes) = correction::correct(db, &cfg, &original).await?;
        Ok(AsrCorrectionResult {
            original,
            corrected,
            changes,
        })
    }

    /// 列出术语词表。
    pub fn list_vocabulary(db: &Database) -> Result<Vec<AsrVocabularyTerm>, AppError> {
        db.list_asr_vocabulary()
    }

    /// 新增/合并术语，返回词条 id。
    pub fn add_vocabulary(
        db: &Database,
        term: &str,
        aliases: &[String],
    ) -> Result<i64, AppError> {
        db.upsert_asr_vocabulary(term, aliases)
    }

    /// 删除术语。
    pub fn remove_vocabulary(db: &Database, id: i64) -> Result<bool, AppError> {
        db.remove_asr_vocabulary(id)
    }

    /// 「测试连接」按钮专用：云端校验鉴权，本地校验模型资源是否就绪。
    pub async fn test_connection(cfg: &AsrConfig, data_dir: &std::path::Path) -> AsrTestResult {
        let start = std::time::Instant::now();
        let result = match cfg.provider {
            AsrProviderKind::Dashscope => {
                if cfg.api_key.trim().is_empty() {
                    return AsrTestResult {
                        ok: false,
                        latency_ms: 0,
                        message: Some("API Key 不能为空".into()),
                    };
                }
                dashscope::probe(cfg).await
            }
            AsrProviderKind::Local => {
                let st = local_model::status(data_dir);
                if st.ready {
                    Ok(())
                } else {
                    Err(AppError::InvalidInput(
                        st.message.unwrap_or_else(|| "本地模型未就绪".into()),
                    ))
                }
            }
        };
        match result {
            Ok(_) => AsrTestResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                message: None,
            },
            Err(e) => AsrTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: Some(e.to_string()),
            },
        }
    }
}
