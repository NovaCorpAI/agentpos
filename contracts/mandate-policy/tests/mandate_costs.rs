//! What it costs the network to enforce the mandate.
//!
//! Prints the resources the host metered for an agent payment (token transfer plus the
//! account's `__check_auth`, the signature verification and the policy) and for each owner
//! operation. The figures only describe the deployed contracts when the tests run against
//! the WASM artifacts (`AGENTPOS_WASM_DIR`); natively they are a lower bound.
//!
//! Run with:
//! `AGENTPOS_WASM_DIR=target/wasm32v1-none/release cargo test -p agentpos-mandate-policy \
//!  --test mandate_costs -- --nocapture`

extern crate std;

mod common;

use common::*;
use soroban_sdk::vec;

/// Regression budget for one agent payment, in CPU instructions. It is our own ceiling,
/// set above the measured figure so that an accidental blow-up fails CI. It is not a
/// network limit.
const PAYMENT_INSTRUCTION_BUDGET: i64 = 4_000_000;

#[test]
fn costs_of_enforcing_the_mandate() {
    let mut w = World::new();
    let mode = if wasm_dir().is_some() {
        "wasm"
    } else {
        "native (lower bound)"
    };
    let mut report = std::vec::Vec::new();
    let mut measure = |w: &World, label: &str| {
        let r = w.e.cost_estimate().resources();
        report.push(std::format!("{label}: {r:?}"));
        r.instructions
    };

    w.pay(&w.seller, USDC).unwrap();
    let first_payment = measure(&w, "agent payment (first of the period)");

    w.pay(&w.seller, USDC).unwrap();
    w.pay(&w.seller, USDC).unwrap();
    w.pay(&w.seller, USDC).unwrap();
    let later_payment = measure(&w, "agent payment (fourth of the period)");

    let _ = w.pay(&w.seller, PER_PAYMENT_CAP + 1);
    measure(&w, "agent payment over the cap (rejected)");

    let sellers = vec![&w.e, w.seller.clone(), w.other_seller.clone()];
    w.set_mandate(&w.owner, OWNER_RULE, PER_PAYMENT_CAP, PERIOD_CAP, &sellers)
        .unwrap();
    measure(&w, "owner sets the policy");

    let agent = w.agent.clone();
    let second = w
        .issue_session(&w.owner, OWNER_RULE, &agent, &w.default_params())
        .unwrap();
    measure(&w, "owner issues a session");

    w.session = second;
    w.revoke_session(&w.owner, OWNER_RULE).unwrap();
    measure(&w, "owner revokes a session");

    std::println!("\nMandate enforcement costs, {mode}");
    for line in &report {
        std::println!("  {line}");
    }

    if wasm_dir().is_some() {
        assert!(
            first_payment < PAYMENT_INSTRUCTION_BUDGET
                && later_payment < PAYMENT_INSTRUCTION_BUDGET,
            "an agent payment costs {first_payment} / {later_payment} instructions, over our \
             budget of {PAYMENT_INSTRUCTION_BUDGET}"
        );
    }
}
