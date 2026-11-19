//! Same vectors as the TypeScript engine (test/policy.test.ts).
use serde_json::Value;
use signguard_policy::logic::{self, Facts, Rules};

#[test]
fn shared_policy_vectors() {
    let v: Value = serde_json::from_str(include_str!("../../../test-vectors/policy.json")).unwrap();
    let now = v["now"].as_u64().unwrap();
    let defaults = v["defaultRules"].as_object().unwrap().clone();
    let d: Rules = serde_json::from_value(Value::Object(defaults.clone())).unwrap();
    assert_eq!(serde_json::to_value(&d).unwrap(), serde_json::to_value(Rules::default()).unwrap(), "Rust defaults match TS defaults");
    let mut n = 0;
    for c in v["cases"].as_array().unwrap() {
        let mut r = defaults.clone();
        if let Some(o) = c.get("rules").and_then(|x| x.as_object()) {
            for (k, val) in o { r.insert(k.clone(), val.clone()); }
        }
        let input = serde_json::to_vec(&serde_json::json!({ "rules": r })).unwrap();
        let rules = logic::parse_rules(&input).unwrap();
        let facts: Vec<Facts> = serde_json::from_value(c["facts"].clone()).unwrap();
        let res = logic::evaluate(&facts, &rules, now);
        let name = c["name"].as_str().unwrap();
        let want_v = c["expect"]["verdict"].as_str().unwrap();
        assert_eq!(serde_json::to_value(res.verdict).unwrap().as_str().unwrap(), want_v, "{name}");
        let mut got: Vec<&str> = res.codes.iter().map(|h| h.code).collect();
        let mut want: Vec<&str> = c["expect"]["codes"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        got.sort();
        want.sort();
        assert_eq!(got, want, "{name}");
        n += 1;
    }
    assert!(n >= 10);
}

#[test]
fn delegated_calls_cannot_write_rules() {
    assert!(logic::self_only_key(Some(b"user"), true).is_err());
    assert!(logic::self_only_key(Some(b"user"), false).is_ok());
    assert!(logic::subject_key(None).is_err());
}

#[test]
fn rejects_bad_rules() {
    let bad = br#"{"rules":{"blockUnlimitedApprovals":true,"blockApprovalForAll":true,"maxSpendUsd":-1,"maxLeverage":null,"allowlist":[],"unlistedContract":"warn","permitSignatures":"warn","maxPermitDays":null}}"#;
    assert!(logic::parse_rules(bad).is_err());
    let extra = br#"{"rules":{"evil":1}}"#;
    assert!(logic::parse_rules(extra).is_err());
}
