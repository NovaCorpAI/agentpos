//! The mandate in one story, printed step by step.
//!
//! This is a test like the others: real authorization entries signed with Ed25519, through
//! the host into `__check_auth`, the verifier and the policy, and every step asserted. It
//! also prints what happens in plain words, so it can be shown to someone.
//!
//! Run it with `contracts/demo.sh`, or:
//!
//! ```bash
//! cargo test -p agentpos-mandate-policy --test mandate_demo -- --nocapture
//! ```
//!
//! `AGENTPOS_DEMO_PAUSE_MS` adds a pause between steps (for a recording). `NO_COLOR`
//! turns the colors off.

extern crate std;

mod common;

use std::io::Write as _;

use agentpos_mandate_account::MandateAccountClient;
use agentpos_mandate_policy::MandateError;
use common::*;
use soroban_sdk::vec;
use stellar_accounts::{
    policies::spending_limit::SpendingLimitError, smart_account::SmartAccountError,
};

const WIDTH: usize = 44;

fn color(code: &str, text: &str) -> std::string::String {
    if std::env::var_os("NO_COLOR").is_some() {
        text.into()
    } else {
        std::format!("\x1b[{code}m{text}\x1b[0m")
    }
}

fn pause() {
    let ms = std::env::var("AGENTPOS_DEMO_PAUSE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn say(line: &str) {
    std::println!("{line}");
    pause();
}

fn scene(title: &str) {
    std::println!();
    say(&color("1", title));
}

fn usdc(amount: i128) -> std::string::String {
    std::format!("{}", amount / USDC)
}

fn state(w: &World) -> std::string::String {
    std::format!(
        "balance {}, spent {} of {}",
        usdc(w.balance(&w.account)),
        usdc(w.mandate().spent_in_period),
        usdc(w.mandate().period_cap)
    )
}

fn row(what: &str, verdict: &str, detail: &str) {
    let dots = ".".repeat(WIDTH.saturating_sub(what.len()));
    say(&std::format!("  {what} {dots} {verdict}  {detail}"));
}

fn accepted<T>(w: &World, what: &str, result: Rejected<T>) {
    assert!(result.is_ok(), "{what}: expected the network to accept");
    row(what, &color("32", "ACCEPTED"), &state(w));
}

fn rejected<T: core::fmt::Debug>(w: &World, what: &str, result: Rejected<T>, code: u32, why: &str) {
    assert_rejected(w, result, code);
    row(
        what,
        &color("31", "REJECTED"),
        &std::format!("{why} ({code})"),
    );
}

#[test]
fn demo_the_mandate_in_one_story() {
    let mut w = World::new();
    let account = MandateAccountClient::new(&w.e, &w.account);

    std::println!();
    say(&color("1", "AgentPOS mandate, enforced by the network"));
    say("Soroban test host. Every call below carries a real Ed25519 signature.");

    scene("Setup");
    say("  The owner's smart account holds 100 USDC.");
    say("  The owner gives the buying agent a session key with a mandate:");
    say("    up to 5 USDC per payment, 12 USDC per period, one allowed seller.");

    scene("1. The agent buys within the mandate");
    accepted(&w, "pay 4 USDC to the seller", w.pay(&w.seller, 4 * USDC));

    scene("2. The agent tries to go past the mandate");
    rejected(
        &w,
        "pay 6 USDC to the seller",
        w.pay(&w.seller, 6 * USDC),
        MandateError::OverPaymentCap as u32,
        "over the cap per payment",
    );
    rejected(
        &w,
        "pay 1 USDC to another address",
        w.pay(&w.stranger, USDC),
        MandateError::SellerNotAllowed as u32,
        "seller not on the list",
    );
    accepted(&w, "pay 5 USDC to the seller", w.pay(&w.seller, 5 * USDC));
    rejected(
        &w,
        "pay 5 USDC to the seller",
        w.pay(&w.seller, 5 * USDC),
        SpendingLimitError::SpendingLimitExceeded as u32,
        "over the cap per period",
    );

    scene("3. The agent's key leaks. A thief has it.");
    let policy_id = account.get_policy_id(&w.policy);
    w.authorize(
        Some(&w.agent),
        w.session,
        &w.account,
        "remove_policy",
        std::vec![to_scval(&w.e, w.session), to_scval(&w.e, policy_id)],
    );
    rejected(
        &w,
        "remove the mandate from the session",
        flatten(account.try_remove_policy(&w.session, &policy_id)),
        SmartAccountError::UnvalidatedContext as u32,
        "only the owner can",
    );
    let thief_address = vec![&w.e, w.stranger.clone()];
    rejected(
        &w,
        "raise the caps and add the thief as seller",
        w.set_mandate(&w.agent, w.session, 100 * USDC, 100 * USDC, &thief_address),
        SmartAccountError::UnvalidatedContext as u32,
        "only the owner can",
    );
    rejected(
        &w,
        "pay 3 USDC to the thief",
        w.pay(&w.stranger, 3 * USDC),
        MandateError::SellerNotAllowed as u32,
        "seller not on the list",
    );
    say("  All a stolen key can do is what the mandate still allows:");
    accepted(&w, "pay 3 USDC to the seller", w.pay(&w.seller, 3 * USDC));
    rejected(
        &w,
        "pay 1 USDC to the seller",
        w.pay(&w.seller, USDC),
        SpendingLimitError::SpendingLimitExceeded as u32,
        "over the cap per period",
    );

    scene("4. The owner revokes the session");
    let revoked = w.revoke_session(&w.owner, OWNER_RULE);
    assert!(revoked.is_ok(), "the owner revokes");
    row(
        "revoke the agent's session",
        &color("32", "ACCEPTED"),
        "signed by the owner",
    );
    rejected(
        &w,
        "pay 1 USDC to the seller",
        w.pay(&w.seller, USDC),
        SmartAccountError::ContextRuleNotFound as u32,
        "the session no longer exists",
    );

    scene("5. Later, a new session starts with a clean period");
    let agent = w.agent.clone();
    w.session = w
        .issue_session(&w.owner, OWNER_RULE, &agent, &w.default_params())
        .expect("the owner issues a new session");
    accepted(&w, "pay 2 USDC to the seller", w.pay(&w.seller, 2 * USDC));

    assert_eq!(w.balance(&w.account), 86 * USDC);
    assert_eq!(w.balance(&w.seller), 14 * USDC);
    assert_eq!(w.balance(&w.stranger), 0);

    scene("Result");
    say(&std::format!(
        "  The seller received {} USDC. The thief received {}. The account keeps {}.",
        usdc(w.balance(&w.seller)),
        usdc(w.balance(&w.stranger)),
        usdc(w.balance(&w.account))
    ));
    say("  No AgentPOS server took part. The contract enforced every limit.");
    std::println!();
}
