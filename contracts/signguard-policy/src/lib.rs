//! `z:<tenant>:signguard` — SignGuard's private pre-sign policy.
//!
//! Map (create before first use; read/write for this contract only):
//! - `rules`: `calling user DID` → that user's rules as JSON.
//!
//! - `set-rules` / `forget`: the user, for themselves only.
//! - `check`: the user or an agent they granted; returns verdict + reason
//!   codes. Thresholds and allowlist entries never leave the enclave.

extern crate alloc;

pub mod logic;

#[cfg(target_arch = "wasm32")]
mod guest {
    use alloc::format;
    use alloc::string::{String, ToString};
    use alloc::vec::Vec;
    use serde_json::json;

    use super::logic::{self, Rules};

    wit_bindgen::generate!({ world: "signguard", path: "wit", generate_all });

    use exports::z::signguard::contracts::{GenericInput, Guest};
    use host::interfaces::{kv_store, logging};
    use host::tenant::tenant_context;

    fn rules_map() -> String {
        format!("z:{}:{}", hex::encode(tenant_context::tenant_did()), logic::RULES_MAP_TAIL)
    }
    fn input(req: &GenericInput) -> Result<&[u8], String> {
        req.input.as_deref().ok_or_else(|| "invalid input: missing input".to_string())
    }
    fn reply(v: serde_json::Value) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&v).map_err(|e| e.to_string())
    }

    struct Component;

    impl Guest for Component {
        fn set_rules(req: GenericInput) -> Result<Vec<u8>, String> {
            let key = logic::self_only_key(tenant_context::calling_user_did().as_deref(), tenant_context::is_delegated()).map_err(|e| e.to_string())?;
            let rules = logic::parse_rules(input(&req)?).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&rules).map_err(|e| e.to_string())?;
            kv_store::put(&rules_map(), &key, &bytes)?;
            logging::info("set-rules: saved")?; // never log a value
            reply(json!({ "stored": true, "custom": { "sg_op": "set_rules" } }))
        }

        fn check(req: GenericInput) -> Result<Vec<u8>, String> {
            // On an agent call this is the user who granted it (pii_did); the agent can't name anyone else.
            let key = logic::subject_key(tenant_context::calling_user_did().as_deref()).map_err(|e| e.to_string())?;
            let facts = logic::parse_facts(input(&req)?).map_err(|e| e.to_string())?;
            let (rules, src) = match kv_store::get(&rules_map(), &key)? {
                Some(b) => (serde_json::from_slice::<Rules>(&b).map_err(|_| "corrupt rules".to_string())?, "user"),
                None => (Rules::default(), "default"),
            };
            let r = logic::evaluate(&facts, &rules, tenant_context::cluster_timestamp_secs());
            let verdict = serde_json::to_value(r.verdict).map_err(|e| e.to_string())?;
            let v = verdict.as_str().unwrap_or("warn").to_string();
            reply(json!({
                "verdict": verdict,
                "codes": r.codes,
                // Lifted into the T3N activity log entry (no personal data).
                "custom": { "sg_op": "check", "verdict": v, "hits": r.codes.len().to_string(), "rules": src },
            }))
        }

        fn forget(_req: GenericInput) -> Result<Vec<u8>, String> {
            let key = logic::self_only_key(tenant_context::calling_user_did().as_deref(), tenant_context::is_delegated()).map_err(|e| e.to_string())?;
            let deleted = kv_store::delete(&rules_map(), &key)?;
            logging::info("forget: deleted")?;
            reply(json!({ "deleted": deleted, "custom": { "sg_op": "forget" } }))
        }
    }

    export!(Component);
}
