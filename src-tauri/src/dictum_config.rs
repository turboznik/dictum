//! The shared Dictum server endpoint, compiled in from `dictum.config.json`.
//!
//! The desktop app and the Dictum server must agree on one base URL. Keeping
//! the single source of truth at the repository root lets `server/config.ts`
//! read the very same file at runtime, so a build and the server it talks to
//! cannot drift apart.
//!
//! This is deliberately compile-time (`include_str!`): the endpoint is part of
//! a corporate build's identity, not a user preference. Retargeting Dictum at a
//! centrally deployed server is an adopter's rebuild, not a setting.

use once_cell::sync::Lazy;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DictumConfig {
    server_base_url: String,
    post_process_model: String,
}

static CONFIG: Lazy<DictumConfig> = Lazy::new(|| {
    let mut config: DictumConfig = serde_json::from_str(include_str!("../../dictum.config.json"))
        .expect("dictum.config.json is valid JSON with serverBaseUrl and postProcessModel");
    // Every derived endpoint joins with "/", so normalise once here rather than
    // at each use site.
    config.server_base_url = config.server_base_url.trim_end_matches('/').to_string();
    config
});

/// Base URL of the Dictum server, without a trailing slash.
pub fn server_base_url() -> &'static str {
    &CONFIG.server_base_url
}

/// Endpoint for the model mirror, in the shape `hf-hub` expects as its API
/// endpoint: it appends `/{repo_id}/resolve/{revision}/{filename}`.
pub static MODEL_MIRROR_ENDPOINT: Lazy<String> =
    Lazy::new(|| format!("{}/api/hf", server_base_url()));

/// Base URL for the post-processing gateway. The LLM client appends
/// `/chat/completions`.
pub static POST_PROCESS_BASE_URL: Lazy<String> =
    Lazy::new(|| format!("{}/api/post-process", server_base_url()));

/// The model Dictum asks the gateway for. The gateway forces this same value
/// regardless of what a client sends, so this only keeps the desktop app's
/// request honest and the settings UI truthful.
pub fn post_process_model() -> &'static str {
    &CONFIG.post_process_model
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_derive_from_the_shared_base_url() {
        let base = server_base_url();
        assert!(!base.ends_with('/'), "base url must not end with a slash");
        assert_eq!(*MODEL_MIRROR_ENDPOINT, format!("{base}/api/hf"));
        assert_eq!(*POST_PROCESS_BASE_URL, format!("{base}/api/post-process"));
    }

    #[test]
    fn post_process_model_is_configured() {
        assert!(!post_process_model().is_empty());
    }
}
