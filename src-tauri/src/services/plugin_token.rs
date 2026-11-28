//! 插件运行时令牌注册表
//!
//! 设计要点：
//! - 内存存储（Mutex），进程退出自动清空
//! - 每次 acquire 生成新的 token + session_id，同插件允许多个会话并存
//! - 令牌绑定「插件 + 当前启用代际」：代际一旦变化，旧令牌全部闲置（校验时拒绝）
//! - 停用/卸载调用 `revoke_plugin` 一次性失效该插件全部会话

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use uuid::Uuid;

/// 一个活跃的插件运行会话
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSession {
    pub plugin_id: String,
    /// 申领令牌时的启用代际；与数据库当前代际不一致即视为过期
    pub generation: i64,
    pub session_id: String,
}

#[derive(Default)]
struct Inner {
    by_token: HashMap<String, PluginSession>,
    tokens_by_plugin: HashMap<String, HashSet<String>>,
}

#[derive(Default)]
pub struct PluginTokenRegistry {
    inner: Mutex<Inner>,
}

impl PluginTokenRegistry {
    /// 申领新令牌。返回 `(token, session)`。
    pub fn acquire(&self, plugin_id: &str, generation: i64) -> Result<(String, PluginSession), String> {
        let token = Uuid::new_v4().to_string();
        let session = PluginSession {
            plugin_id: plugin_id.to_string(),
            generation,
            session_id: Uuid::new_v4().to_string(),
        };
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        guard.by_token.insert(token.clone(), session.clone());
        guard
            .tokens_by_plugin
            .entry(plugin_id.to_string())
            .or_default()
            .insert(token.clone());
        Ok((token, session))
    }

    /// 作废单个令牌（幂等）。返回是否真的移除了。
    pub fn revoke(&self, token: &str) -> Result<bool, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        match guard.by_token.remove(token) {
            Some(session) => {
                if let Some(tokens) = guard.tokens_by_plugin.get_mut(&session.plugin_id) {
                    tokens.remove(token);
                    if tokens.is_empty() {
                        guard.tokens_by_plugin.remove(&session.plugin_id);
                    }
                }
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// 作废某插件的全部会话，返回失效的令牌数。
    pub fn revoke_plugin(&self, plugin_id: &str) -> Result<usize, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let tokens = guard
            .tokens_by_plugin
            .remove(plugin_id)
            .unwrap_or_default();
        for token in &tokens {
            guard.by_token.remove(token);
        }
        Ok(tokens.len())
    }

    /// 通过令牌反查会话；找不到 → None。
    pub fn lookup(&self, token: &str) -> Result<Option<PluginSession>, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(guard.by_token.get(token).cloned())
    }

    /// 某插件当前活跃会话数（测试/诊断用）。
    pub fn session_count(&self, plugin_id: &str) -> Result<usize, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(guard
            .tokens_by_plugin
            .get(plugin_id)
            .map(|set| set.len())
            .unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_returns_token_and_session() {
        let registry = PluginTokenRegistry::default();
        let (token, session) = registry.acquire("cc", 3).unwrap();
        assert_eq!(token.len(), 36);
        assert_eq!(session.plugin_id, "cc");
        assert_eq!(session.generation, 3);
        assert_eq!(registry.lookup(&token).unwrap(), Some(session));
    }

    #[test]
    fn sessions_coexist_for_same_plugin() {
        let registry = PluginTokenRegistry::default();
        let (t1, _) = registry.acquire("cc", 1).unwrap();
        let (t2, _) = registry.acquire("cc", 1).unwrap();
        assert_ne!(t1, t2);
        assert_eq!(registry.session_count("cc").unwrap(), 2);
        assert!(registry.lookup(&t1).unwrap().is_some());
        assert!(registry.lookup(&t2).unwrap().is_some());
    }

    #[test]
    fn revoke_plugin_invalidates_all_sessions() {
        let registry = PluginTokenRegistry::default();
        let (t1, _) = registry.acquire("cc", 1).unwrap();
        let (t2, _) = registry.acquire("cc", 1).unwrap();
        let (other, _) = registry.acquire("other", 1).unwrap();

        assert_eq!(registry.revoke_plugin("cc").unwrap(), 2);
        assert!(registry.lookup(&t1).unwrap().is_none());
        assert!(registry.lookup(&t2).unwrap().is_none());
        assert!(registry.lookup(&other).unwrap().is_some());
        assert_eq!(registry.session_count("cc").unwrap(), 0);
    }

    #[test]
    fn revoke_single_token_is_idempotent() {
        let registry = PluginTokenRegistry::default();
        let (token, _) = registry.acquire("cc", 1).unwrap();
        assert!(registry.revoke(&token).unwrap());
        assert!(!registry.revoke(&token).unwrap());
    }

    #[test]
    fn lookup_invalid_token_is_none() {
        let registry = PluginTokenRegistry::default();
        assert!(registry.lookup("invalid").unwrap().is_none());
    }
}
