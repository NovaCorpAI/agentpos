//! Acceptance matrix of the mandate: every accept path and every rejection.
//!
//! Payments and owner operations are NOT mocked: see `common/mod.rs`. Each rejection is
//! asserted together with its contract error code.
//!
//! Run with `cargo test -p agentpos-mandate-policy --test mandate_matrix`.

extern crate std;

mod common;

use agentpos_mandate_account::MandateAccountClient;
use agentpos_mandate_policy::{MandateError, MandateParams};
use common::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    vec, Address,
};
use stellar_accounts::{
    policies::spending_limit::SpendingLimitError, smart_account::SmartAccountError,
};

// ---------------------------------------------------------------------------------------
// Accept paths
// ---------------------------------------------------------------------------------------

#[test]
fn accept_01_payment_within_caps_to_an_allowed_seller() {
    let w = World::new();
    w.pay(&w.seller, 3 * USDC).expect("within the mandate");
    assert_eq!(w.balance(&w.seller), 3 * USDC);
    assert_eq!(w.balance(&w.account), 97 * USDC);
    assert_eq!(w.mandate().spent_in_period, 3 * USDC);
}

#[test]
fn accept_02_payment_of_exactly_the_cap_per_payment() {
    let w = World::new();
    w.pay(&w.seller, PER_PAYMENT_CAP)
        .expect("the cap itself is allowed");
    assert_eq!(w.balance(&w.seller), PER_PAYMENT_CAP);
}

#[test]
fn accept_03_payments_that_add_up_to_exactly_the_cap_per_period() {
    let w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.pay(&w.seller, 2 * USDC).unwrap();
    assert_eq!(w.balance(&w.seller), PERIOD_CAP);
    assert_eq!(w.mandate().spent_in_period, PERIOD_CAP);
}

#[test]
fn accept_04_payment_after_the_period_rolls_over() {
    let w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.pay(&w.seller, 5 * USDC).unwrap();
    assert!(
        w.pay(&w.seller, 5 * USDC).is_err(),
        "15 USDC in one period is over the cap"
    );

    w.advance(PERIOD_LEDGERS);
    assert_eq!(w.mandate().spent_in_period, 0);
    w.pay(&w.seller, 5 * USDC)
        .expect("a new period has started");
    assert_eq!(w.balance(&w.seller), 15 * USDC);
}

#[test]
fn accept_05_owner_sets_the_policy_and_the_new_terms_apply() {
    let w = World::new();
    let sellers = vec![&w.e, w.seller.clone(), w.other_seller.clone()];
    w.set_mandate(&w.owner, OWNER_RULE, 8 * USDC, 20 * USDC, &sellers)
        .expect("owner operation");

    let mandate = w.mandate();
    assert_eq!(mandate.per_payment_cap, 8 * USDC);
    assert_eq!(mandate.period_cap, 20 * USDC);
    assert_eq!(mandate.sellers, sellers);

    w.pay(&w.other_seller, 8 * USDC)
        .expect("new seller, new cap per payment");
    assert_eq!(w.balance(&w.other_seller), 8 * USDC);
}

#[test]
fn accept_06_owner_issues_a_second_session_with_its_own_mandate() {
    let mut w = World::new();
    let second_agent = key(3);
    let params = MandateParams {
        per_payment_cap: USDC,
        period_cap: 2 * USDC,
        period_ledgers: PERIOD_LEDGERS,
        sellers: vec![&w.e, w.other_seller.clone()],
    };
    let second = w
        .issue_session(&w.owner, OWNER_RULE, &second_agent, &params)
        .unwrap();
    assert_ne!(second, w.session);

    w.pay_as(Some(&second_agent), second, &w.other_seller, USDC)
        .expect("second mandate");
    w.pay(&w.seller, 5 * USDC)
        .expect("the first mandate is independent");

    w.session = second;
    assert_eq!(w.mandate().spent_in_period, USDC);
}

#[test]
fn accept_07_owner_revokes_the_session() {
    let w = World::new();
    w.revoke_session(&w.owner, OWNER_RULE)
        .expect("owner operation");
    assert_eq!(
        MandateAccountClient::new(&w.e, &w.account).get_context_rules_count(),
        1
    );
}

#[test]
fn accept_08_owner_is_not_bound_by_the_agents_mandate() {
    let w = World::new();
    w.pay_as(Some(&w.owner), OWNER_RULE, &w.stranger, 50 * USDC)
        .expect("the owner's own money, under the owner rule");
    assert_eq!(w.balance(&w.stranger), 50 * USDC);
}

// ---------------------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------------------

#[test]
fn reject_01_payment_over_the_cap_per_payment() {
    let w = World::new();
    let result = w.pay(&w.seller, PER_PAYMENT_CAP + 1);
    assert_rejected(&w, result, MandateError::OverPaymentCap as u32);
    w.assert_untouched(0);
}

#[test]
fn reject_02_payment_over_the_cap_per_period() {
    let w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.pay(&w.seller, 5 * USDC).unwrap();
    let result = w.pay(&w.seller, 2 * USDC + 1);
    assert_rejected(&w, result, SpendingLimitError::SpendingLimitExceeded as u32);
    w.assert_untouched(10 * USDC);
}

#[test]
fn reject_03_payment_to_a_seller_that_is_not_allowed() {
    let w = World::new();
    let result = w.pay(&w.stranger, USDC);
    assert_rejected(&w, result, MandateError::SellerNotAllowed as u32);
    assert_eq!(w.balance(&w.stranger), 0);
    w.assert_untouched(0);
}

#[test]
fn reject_04_payment_after_the_session_expired() {
    let w = World::new();
    w.advance(SESSION_LEDGERS);
    w.pay(&w.seller, USDC).expect("the last valid ledger");

    w.advance(1);
    let result = w.pay(&w.seller, USDC);
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(w.balance(&w.seller), USDC);
}

#[test]
fn reject_05_payment_after_the_session_was_revoked() {
    let w = World::new();
    w.pay(&w.seller, USDC).unwrap();
    w.revoke_session(&w.owner, OWNER_RULE).unwrap();

    let result = w.pay(&w.seller, USDC);
    assert_rejected(&w, result, SmartAccountError::ContextRuleNotFound as u32);
    assert_eq!(w.balance(&w.seller), USDC);
}

#[test]
fn reject_06_policy_change_signed_by_the_agent() {
    let w = World::new();
    let sellers = vec![&w.e, w.stranger.clone()];
    let result = w.set_mandate(&w.agent, w.session, 100 * USDC, 100 * USDC, &sellers);
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(w.mandate().per_payment_cap, PER_PAYMENT_CAP);
}

#[test]
fn reject_07_policy_change_signed_by_the_agent_claiming_the_owner_rule() {
    let w = World::new();
    let sellers = vec![&w.e, w.stranger.clone()];
    let result = w.set_mandate(&w.agent, OWNER_RULE, 100 * USDC, 100 * USDC, &sellers);
    // The owner rule has no policy, so every one of its signers must have signed.
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(w.mandate().per_payment_cap, PER_PAYMENT_CAP);
}

#[test]
fn reject_08_session_issued_by_the_agent() {
    let w = World::new();
    let params = MandateParams {
        per_payment_cap: 100 * USDC,
        period_cap: 100 * USDC,
        period_ledgers: PERIOD_LEDGERS,
        sellers: vec![&w.e, w.stranger.clone()],
    };
    let result = w.issue_session(&w.agent, w.session, &key(9), &params);
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(
        MandateAccountClient::new(&w.e, &w.account).get_context_rules_count(),
        2
    );
}

#[test]
fn reject_09_session_revoked_by_a_non_owner() {
    let w = World::new();
    let result = w.revoke_session(&w.agent, w.session);
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    w.pay(&w.seller, USDC).expect("the session is still there");
}

#[test]
fn reject_10_session_extended_by_the_agent() {
    let w = World::new();
    let e = &w.e;
    let valid_until = Some(START_LEDGER + 1_000_000);
    w.authorize(
        Some(&w.agent),
        w.session,
        &w.account,
        "update_context_rule_valid_until",
        std::vec![to_scval(e, w.session), to_scval(e, valid_until)],
    );
    let result = flatten(
        MandateAccountClient::new(e, &w.account)
            .try_update_context_rule_valid_until(&w.session, &valid_until),
    );
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
}

#[test]
fn reject_11_token_call_that_is_not_a_transfer() {
    let w = World::new();
    let e = &w.e;
    let expiration = START_LEDGER + 1_000;
    w.authorize(
        Some(&w.agent),
        w.session,
        &w.usdc,
        "approve",
        std::vec![
            to_scval(e, w.account.clone()),
            to_scval(e, w.stranger.clone()),
            to_scval(e, 100 * USDC),
            to_scval(e, expiration),
        ],
    );
    let token = TokenClient::new(e, &w.usdc);
    let result = flatten(token.try_approve(&w.account, &w.stranger, &(100 * USDC), &expiration));
    assert_rejected(&w, result, MandateError::NotATransfer as u32);
    assert_eq!(token.allowance(&w.account, &w.stranger), 0);
}

#[test]
fn reject_12_payment_without_the_session_signature() {
    let w = World::new();
    let result = w.pay_as(None, w.session, &w.seller, USDC);
    assert_rejected(&w, result, MandateError::MissingSessionSignature as u32);
    w.assert_untouched(0);
}

#[test]
fn reject_13_payment_signed_by_an_unknown_key() {
    let w = World::new();
    let result = w.pay_as(Some(&key(7)), w.session, &w.seller, USDC);
    assert_rejected(&w, result, SmartAccountError::UnauthorizedSigner as u32);
    w.assert_untouched(0);
}

#[test]
fn reject_14_payment_of_zero() {
    let w = World::new();
    let result = w.pay(&w.seller, 0);
    assert_rejected(&w, result, MandateError::NonPositiveAmount as u32);
}

#[test]
fn reject_15_payment_in_a_token_the_session_is_not_scoped_to() {
    let w = World::new();
    let e = &w.e;
    let other_token = e
        .register_stellar_asset_contract_v2(Address::generate(e))
        .address();
    e.mock_all_auths();
    StellarAssetClient::new(e, &other_token).mint(&w.account, &(100 * USDC));

    w.authorize(
        Some(&w.agent),
        w.session,
        &other_token,
        "transfer",
        std::vec![
            to_scval(e, w.account.clone()),
            to_scval(e, w.seller.clone()),
            to_scval(e, USDC)
        ],
    );
    let token = TokenClient::new(e, &other_token);
    let result = flatten(token.try_transfer(&w.account, &w.seller, &USDC));
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(token.balance(&w.seller), 0);
}

#[test]
fn reject_16_mandate_with_invalid_terms() {
    let w = World::new();
    let no_sellers = MandateParams {
        sellers: vec![&w.e],
        ..w.default_params()
    };
    let result = w.issue_session(&w.owner, OWNER_RULE, &key(4), &no_sellers);
    assert_rejected(&w, result, MandateError::InvalidParams as u32);

    let cap_over_period = MandateParams {
        per_payment_cap: PERIOD_CAP + 1,
        ..w.default_params()
    };
    let result = w.issue_session(&w.owner, OWNER_RULE, &key(5), &cap_over_period);
    assert_rejected(&w, result, MandateError::InvalidParams as u32);
}
