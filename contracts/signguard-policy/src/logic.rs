//! Pure policy logic (no host calls) — a line-for-line port of
//! src/core/rules.ts. Both are tested against test-vectors/policy.json.

use alloc::collections::BTreeSet;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

pub const RULES_MAP_TAIL: &str = "rules";

#[derive(Debug)]
pub enum PolicyError {
    InvalidInput(String),
    NotSelf,
    NoCaller,
}

impl core::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PolicyError::InvalidInput(m) => write!(f, "invalid input: {m}"),
            PolicyError::NotSelf => write!(f, "only the user can change their own rules"),
            PolicyError::NoCaller => write!(f, "no calling user"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Ignore,
    Warn,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub block_unlimited_approvals: bool,
    pub block_approval_for_all: bool,
    pub max_spend_usd: Option<f64>,
    pub max_leverage: Option<f64>,
    pub allowlist: Vec<String>,
    pub unlisted_contract: Mode,
    pub permit_signatures: Mode,
    pub max_permit_days: Option<f64>,
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            block_unlimited_approvals: true,
            block_approval_for_all: true,
            max_spend_usd: Some(1000.0),
            max_leverage: Some(10.0),
            allowlist: Vec::new(),
            unlisted_contract: Mode::Warn,
            permit_signatures: Mode::Warn,
            max_permit_days: Some(30.0),
        }
    }
}

/// Facts about one tx/signature. Unknown fields are ignored (labels etc.).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub kind: String,
    pub target: Option<String>,
    pub spender: Option<String>,
    pub recipient: Option<String>,
    pub amount_raw: Option<String>,
    pub amount: Option<f64>,
    pub amount_usd: Option<f64>,
    pub unlimited: Option<bool>,
    pub approval_for_all: Option<bool>,
    pub leverage: Option<f64>,
    pub deadline: Option<f64>,
    pub offchain_signature: Option<bool>,
    pub spender_known: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub code: &'static str,
    pub severity: Verdict,
}

#[derive(Debug, Clone, Serialize)]
pub struct PolicyResult {
    pub verdict: Verdict,
    pub codes: Vec<Hit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetRulesInput {
    rules: Rules,
}

#[derive(Deserialize)]
struct CheckInput {
    facts: Vec<Facts>,
}

pub fn parse_rules(input: &[u8]) -> Result<Rules, PolicyError> {
    let r: SetRulesInput = serde_json::from_slice(input).map_err(|e| PolicyError::InvalidInput(e.to_string()))?;
    let mut rules = r.rules;
    if rules.allowlist.len() > 200 {
        return Err(PolicyError::InvalidInput("allowlist too long".into()));
    }
    for a in rules.allowlist.iter_mut() {
        *a = a.to_ascii_lowercase();
        let ok = a.len() == 42 && a.starts_with("0x") && a[2..].bytes().all(|b| b.is_ascii_hexdigit());
        if !ok {
            return Err(PolicyError::InvalidInput("allowlist entry is not an address".into()));
        }
    }
    for v in [rules.max_spend_usd, rules.max_leverage, rules.max_permit_days].into_iter().flatten() {
        if !(v.is_finite() && v >= 0.0) {
            return Err(PolicyError::InvalidInput("caps must be positive numbers".into()));
        }
    }
    Ok(rules)
}

pub fn parse_facts(input: &[u8]) -> Result<Vec<Facts>, PolicyError> {
    let c: CheckInput = serde_json::from_slice(input).map_err(|e| PolicyError::InvalidInput(e.to_string()))?;
    if c.facts.len() > 64 {
        return Err(PolicyError::InvalidInput("too many facts".into()));
    }
    Ok(c.facts)
}

/// Rules are keyed by the caller's DID — never by a DID from the input.
pub fn self_only_key(calling: Option<&[u8]>, delegated: bool) -> Result<Vec<u8>, PolicyError> {
    if delegated {
        return Err(PolicyError::NotSelf);
    }
    subject_key(calling)
}

pub fn subject_key(calling: Option<&[u8]>) -> Result<Vec<u8>, PolicyError> {
    calling.map(|d| d.to_vec()).ok_or(PolicyError::NoCaller)
}

fn is_approvalish(k: &str) -> bool {
    matches!(k, "approve" | "increaseAllowance" | "permit" | "permit2" | "setApprovalForAll")
}
fn is_spendish(k: &str) -> bool {
    matches!(k, "approve" | "increaseAllowance" | "permit" | "permit2" | "transfer" | "transferFrom" | "native_transfer" | "perp_open" | "contract_call")
}

fn add(hits: &mut Vec<Hit>, code: &'static str, severity: Verdict) {
    if let Some(i) = hits.iter().position(|h| h.code == code) {
        if hits[i].severity >= severity {
            return;
        }
        hits.remove(i);
    }
    hits.push(Hit { code, severity });
}

fn mode_sev(m: Mode) -> Verdict {
    match m {
        Mode::Block => Verdict::Block,
        _ => Verdict::Warn,
    }
}

pub fn evaluate_one(f: &Facts, rules: &Rules, now_secs: u64) -> Vec<Hit> {
    let mut hits = Vec::new();
    let allow: BTreeSet<String> = rules.allowlist.iter().map(|a| a.to_ascii_lowercase()).collect();
    let k = f.kind.as_str();
    let cp = f
        .spender
        .as_ref()
        .or(if k == "transfer" || k == "native_transfer" { f.recipient.as_ref() } else { f.target.as_ref() })
        .map(|s| s.to_ascii_lowercase());
    let allowlisted = cp.as_ref().map(|c| allow.contains(c)).unwrap_or(false);
    let approvalish = is_approvalish(k);
    let unlimited = f.unlimited.unwrap_or(false);

    if k == "unknown" {
        add(&mut hits, "undecodable", Verdict::Warn);
    }
    if approvalish && unlimited && k != "setApprovalForAll" && rules.block_unlimited_approvals {
        add(&mut hits, "unlimited_approval", if allowlisted { Verdict::Warn } else { Verdict::Block });
    }
    if k == "setApprovalForAll" && f.approval_for_all == Some(true) && rules.block_approval_for_all {
        add(&mut hits, "approval_for_all", if allowlisted { Verdict::Warn } else { Verdict::Block });
    }
    if let Some(cap) = rules.max_spend_usd {
        if is_spendish(k) {
            if unlimited {
                add(&mut hits, "spend_over_cap", Verdict::Block);
            } else if let Some(usd) = f.amount_usd {
                if usd > cap {
                    add(&mut hits, "spend_over_cap", Verdict::Block);
                }
            } else if f.amount_raw.is_some() || f.amount.is_some() {
                add(&mut hits, "spend_unpriced", Verdict::Warn);
            }
        }
    }
    if let (Some(cap), Some(lev)) = (rules.max_leverage, f.leverage) {
        if lev > cap {
            add(&mut hits, "leverage_over_cap", Verdict::Block);
        }
    }
    if cp.is_some() && !allowlisted {
        if !allow.is_empty() && rules.unlisted_contract != Mode::Ignore {
            add(&mut hits, "contract_not_allowlisted", mode_sev(rules.unlisted_contract));
        } else if approvalish && f.spender_known == Some(false) && f.approval_for_all != Some(false) {
            add(&mut hits, "unknown_spender", Verdict::Warn);
        }
    }
    if f.offchain_signature == Some(true) && (k == "permit" || k == "permit2") && rules.permit_signatures != Mode::Ignore && !allowlisted {
        add(&mut hits, "permit_signature", mode_sev(rules.permit_signatures));
    }
    if let (Some(days), Some(dl)) = (rules.max_permit_days, f.deadline) {
        if dl > 0.0 && (k == "permit" || k == "permit2") && dl - (now_secs as f64) > days * 86400.0 {
            add(&mut hits, "permit_too_long", Verdict::Warn);
        }
    }
    hits
}

pub fn evaluate(facts: &[Facts], rules: &Rules, now_secs: u64) -> PolicyResult {
    if facts.is_empty() {
        return PolicyResult { verdict: Verdict::Warn, codes: alloc::vec![Hit { code: "undecodable", severity: Verdict::Warn }] };
    }
    let mut merged: Vec<Hit> = Vec::new();
    for f in facts {
        for h in evaluate_one(f, rules, now_secs) {
            match merged.iter().position(|m| m.code == h.code) {
                None => merged.push(h),
                Some(i) if h.severity > merged[i].severity => merged[i] = h,
                _ => {}
            }
        }
    }
    let verdict = merged.iter().map(|h| h.severity).max().unwrap_or(Verdict::Allow);
    merged.sort_by(|a, b| b.severity.cmp(&a.severity));
    PolicyResult { verdict, codes: merged }
}
