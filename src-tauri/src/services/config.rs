use std::collections::HashMap;

use crate::database::Database;
use crate::error::AppError;
use crate::models::AppConfig;

/// 配置键最大长度，防止异常输入写入超长 key
const MAX_CONFIG_KEY_LEN: usize = 256;

/// 配置管理服务
pub struct ConfigService;

impl ConfigService {
    /// 获取所有配置
    pub fn get_all(db: &Database) -> Result<Vec<AppConfig>, AppError> {
        db.get_all_config()
    }

    /// 获取配置值
    pub fn get(db: &Database, key: &str) -> Result<String, AppError> {
        db.get_config(key)?
            .ok_or_else(|| AppError::NotFound(format!("配置项 '{}' 不存在", key)))
    }

    /// 批量获取配置值
    ///
    /// 去空、去重后再查询，避免调用方传入重复 key 造成无谓的
    /// 参数膨胀；不存在的 key 不出现在返回结果中，由前端合并默认值。
    pub fn get_many(db: &Database, keys: &[String]) -> Result<HashMap<String, String>, AppError> {
        let mut unique: Vec<String> = Vec::with_capacity(keys.len());
        for key in keys {
            let trimmed = key.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !unique.iter().any(|k| k == trimmed) {
                unique.push(trimmed.to_string());
            }
        }
        db.get_configs(&unique)
    }

    /// 设置配置值
    pub fn set(db: &Database, key: &str, value: &str) -> Result<(), AppError> {
        validate_key(key)?;
        db.set_config(key, value)
    }

    /// 批量写入配置值（事务）
    pub fn set_many(db: &Database, entries: &[AppConfig]) -> Result<(), AppError> {
        for entry in entries {
            validate_key(&entry.key)?;
        }
        db.set_configs(entries)
    }

    /// 删除配置
    pub fn delete(db: &Database, key: &str) -> Result<(), AppError> {
        let deleted = db.delete_config(key)?;
        if !deleted {
            return Err(AppError::NotFound(format!("配置项 '{}' 不存在", key)));
        }
        Ok(())
    }
}

fn validate_key(key: &str) -> Result<(), AppError> {
    if key.trim().is_empty() {
        return Err(AppError::InvalidInput("配置键不能为空".into()));
    }
    if key.len() > MAX_CONFIG_KEY_LEN {
        return Err(AppError::InvalidInput(format!(
            "配置键长度不能超过 {MAX_CONFIG_KEY_LEN} 个字符"
        )));
    }
    Ok(())
}
