//! Adversarial tests: what an attacker, a careless relayer or a leaked session key can try.
//!
//! The acceptance matrix shows that each rule of the mandate rejects what it should. These
//! tests go after the machinery around the rules: the signature binding, the replay
//! protection, the policy's own entry points and the accounting when something fails.
//!
//! Run with `cargo test -p agentpos-mandate-policy --test mandate_adversarial`.

extern crate std;

mod common;

use agentpos_mandate_account::MandateAccountClient;
use agentpos_mandate_policy::{MandateError, MandateParams, MandatePolicyClient, MAX_SELLERS};
use common::*;
use ed25519_dalek::Signer as _;
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::Address as _,
    token::TokenClient,
    vec, Address, Bytes, BytesN, IntoVal, Map, Symbol,
};
use stellar_accounts::{
    policies::spending_limit::SpendingLimitError,
    smart_account::{AuthDigestPreimage, AuthPayload, Signer, SmartAccountError},
};

/// The call was refused, for a reason that is not one of our contract errors (a bad
/// signature, a used nonce, a missing authorization).
fn assert_refused<T: core::fmt::Debug>(result: Rejected<T>) {
    assert!(
        result.is_err(),
        "expected the network to refuse, got {result:?}"
    );
}

// ---------------------------------------------------------------------------------------
// The signature binds exactly what the agent approved
// ---------------------------------------------------------------------------------------

#[test]
fn attack_01_replaying_a_signed_payment() {
    let w = World::new();
    let entry = w.signed_entry(
        Some(&w.agent),
        w.session,
        &w.transfer_call(&w.seller, 2 * USDC),
    );

    w.e.set_auths(std::slice::from_ref(&entry));
    w.submit_transfer(&w.seller, 2 * USDC)
        .expect("the first submission is the real one");

    w.e.set_auths(&[entry]);
    assert_refused(w.submit_transfer(&w.seller, 2 * USDC));
    assert_eq!(w.balance(&w.seller), 2 * USDC);
    w.assert_untouched(2 * USDC);
}

#[test]
fn attack_02_amount_raised_after_signing() {
    let w = World::new();
    let signed = w.transfer_call(&w.seller, USDC);
    let submitted = w.transfer_call(&w.seller, 5 * USDC);

    w.e.set_auths(&[w.forged_entry(Some(&w.agent), w.session, &signed, w.session, &submitted)]);
    assert_refused(w.submit_transfer(&w.seller, 5 * USDC));
    w.assert_untouched(0);
}

#[test]
fn attack_03_recipient_swapped_after_signing() {
    let w = World::new();
    // Both sellers are allowed, so only the signature stands between them.
    let sellers = vec![&w.e, w.seller.clone(), w.other_seller.clone()];
    w.set_mandate(&w.owner, OWNER_RULE, PER_PAYMENT_CAP, PERIOD_CAP, &sellers)
        .unwrap();

    let signed = w.transfer_call(&w.seller, USDC);
    let submitted = w.transfer_call(&w.other_seller, USDC);
    w.e.set_auths(&[w.forged_entry(Some(&w.agent), w.session, &signed, w.session, &submitted)]);
    assert_refused(w.submit_transfer(&w.other_seller, USDC));
    assert_eq!(w.balance(&w.other_seller), 0);
    w.assert_untouched(0);
}

#[test]
fn attack_04_session_rule_swapped_after_signing() {
    let mut w = World::new();
    // The same agent key holds a second, looser session.
    let loose = MandateParams {
        per_payment_cap: 50 * USDC,
        period_cap: 50 * USDC,
        period_ledgers: PERIOD_LEDGERS,
        sellers: vec![&w.e, w.seller.clone()],
    };
    let agent = w.agent.clone();
    let loose_session = w
        .issue_session(&w.owner, OWNER_RULE, &agent, &loose)
        .unwrap();
    let strict_session = w.session;

    // The agent signed under the strict session; a relayer submits it under the loose one.
    let call = w.transfer_call(&w.seller, 2 * USDC);
    w.e.set_auths(&[w.forged_entry(Some(&w.agent), strict_session, &call, loose_session, &call)]);
    assert_refused(w.submit_transfer(&w.seller, 2 * USDC));

    assert_eq!(w.mandate().spent_in_period, 0);
    w.session = loose_session;
    assert_eq!(w.mandate().spent_in_period, 0);
    assert_eq!(w.balance(&w.seller), 0);
}

#[test]
fn attack_05_signature_over_a_different_payment() {
    let w = World::new();
    // A genuine signature by the agent key, but over another payment, attached to this one.
    let other = w.transfer_call(&w.seller, 3);
    let call = w.transfer_call(&w.seller, 4 * USDC);
    w.e.set_auths(&[w.forged_entry(Some(&w.agent), w.session, &other, w.session, &call)]);
    assert_refused(w.submit_transfer(&w.seller, 4 * USDC));
    w.assert_untouched(0);
}

// ---------------------------------------------------------------------------------------
// The agent cannot rewrite its own session
// ---------------------------------------------------------------------------------------

#[test]
fn attack_06_agent_removes_the_policy_from_its_session() {
    let w = World::new();
    let account = MandateAccountClient::new(&w.e, &w.account);
    let policy_id = account.get_policy_id(&w.policy);

    w.authorize(
        Some(&w.agent),
        w.session,
        &w.account,
        "remove_policy",
        std::vec![to_scval(&w.e, w.session), to_scval(&w.e, policy_id)],
    );
    let result = flatten(account.try_remove_policy(&w.session, &policy_id));
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);

    let result = w.pay(&w.seller, PER_PAYMENT_CAP + 1);
    assert_rejected(&w, result, MandateError::OverPaymentCap as u32);
}

#[test]
fn attack_07_agent_adds_a_signer_to_the_owner_rule() {
    let w = World::new();
    let account = MandateAccountClient::new(&w.e, &w.account);
    let intruder = w.signer_of(&key(66));

    w.authorize(
        Some(&w.agent),
        w.session,
        &w.account,
        "add_signer",
        std::vec![to_scval(&w.e, OWNER_RULE), to_scval(&w.e, intruder.clone())],
    );
    let result = flatten(account.try_add_signer(&OWNER_RULE, &intruder));
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(account.get_context_rule(&OWNER_RULE).signers.len(), 1);
}

#[test]
fn attack_08_agent_uses_execute_to_reach_the_policy() {
    let w = World::new();
    let e = &w.e;
    let account = MandateAccountClient::new(e, &w.account);
    let sellers = vec![e, w.stranger.clone()];
    let target_fn = soroban_sdk::Symbol::new(e, "set_mandate");
    let target_args: soroban_sdk::Vec<soroban_sdk::Val> = vec![
        e,
        (100 * USDC).into_val(e),
        (100 * USDC).into_val(e),
        sellers.into_val(e),
        w.session.into_val(e),
        w.account.clone().into_val(e),
    ];

    w.authorize(
        Some(&w.agent),
        w.session,
        &w.account,
        "execute",
        std::vec![
            to_scval(e, w.policy.clone()),
            to_scval(e, target_fn.clone()),
            to_scval(e, target_args.clone()),
        ],
    );
    let result = flatten(account.try_execute(&w.policy, &target_fn, &target_args));
    assert_rejected(&w, result, SmartAccountError::UnvalidatedContext as u32);
    assert_eq!(w.mandate().per_payment_cap, PER_PAYMENT_CAP);
}

#[test]
fn attack_11_session_with_no_signer_at_all() {
    let w = World::new();
    // A rule that carries only the policy is legal for the account. If the owner ever
    // issues one, the mandate must still demand a signature: otherwise anyone could spend
    // within the caps.
    let no_signers = soroban_sdk::Vec::new(&w.e);
    let open_session = w
        .issue_session_with(&w.owner, OWNER_RULE, &no_signers, &w.default_params())
        .expect("the account accepts a rule with a policy and no signer");

    let result = w.pay_as(None, open_session, &w.seller, USDC);
    assert_rejected(&w, result, MandateError::MissingSessionSignature as u32);
    assert_eq!(w.balance(&w.seller), 0);
}

#[test]
fn attack_12_one_of_two_session_signers() {
    let w = World::new();
    let second = key(21);
    let both = vec![&w.e, w.signer_of(&w.agent), w.signer_of(&second)];
    let joint_session = w
        .issue_session_with(&w.owner, OWNER_RULE, &both, &w.default_params())
        .unwrap();

    // The session needs both keys. One of them alone is not enough.
    let result = w.pay_as(Some(&w.agent), joint_session, &w.seller, USDC);
    assert_rejected(&w, result, MandateError::MissingSessionSignature as u32);
    let result = w.pay_as(Some(&second), joint_session, &w.seller, USDC);
    assert_rejected(&w, result, MandateError::MissingSessionSignature as u32);
    assert_eq!(w.balance(&w.seller), 0);
}

// ---------------------------------------------------------------------------------------
// The policy's entry points, called directly
// ---------------------------------------------------------------------------------------

#[test]
fn attack_09_policy_entry_points_called_without_the_accounts_authorization() {
    let w = World::new();
    let e = &w.e;
    let policy = MandatePolicyClient::new(e, &w.policy);
    let rule = MandateAccountClient::new(e, &w.account).get_context_rule(&w.session);
    let payment = Context::Contract(ContractContext {
        contract: w.usdc.clone(),
        fn_name: symbol_short!("transfer"),
        args: vec![
            e,
            w.account.clone().into_val(e),
            w.seller.clone().into_val(e),
            PER_PAYMENT_CAP.into_val(e),
        ],
    });
    let hostile = MandateParams {
        per_payment_cap: 100 * USDC,
        period_cap: 100 * USDC,
        period_ledgers: 1,
        sellers: vec![e, w.stranger.clone()],
    };

    e.set_auths(&[]);

    // Burning the agent's budget by calling `enforce` from outside.
    assert_refused(flatten(policy.try_enforce(
        &payment,
        &rule.signers,
        &rule,
        &w.account,
    )));
    // Installing a hostile mandate, or wiping the real one.
    assert_refused(flatten(policy.try_install(&hostile, &rule, &w.account)));
    assert_refused(flatten(policy.try_uninstall(&rule, &w.account)));
    assert_refused(flatten(policy.try_set_mandate(
        &hostile.per_payment_cap,
        &hostile.period_cap,
        &hostile.sellers,
        &w.session,
        &w.account,
    )));

    assert_eq!(w.mandate().per_payment_cap, PER_PAYMENT_CAP);
    assert_eq!(w.mandate().sellers, vec![e, w.seller.clone()]);
    w.assert_untouched(0);
}

#[test]
fn attack_10_owner_of_another_account_changes_this_mandate() {
    let a = World::new();
    let b = a.sibling(key(11), key(12));
    let e = &a.e;
    let sellers = vec![e, a.stranger.clone()];

    // B's owner signs a perfectly valid authorization, for B. The call names A.
    b.authorize(
        Some(&b.owner),
        OWNER_RULE,
        &b.policy,
        "set_mandate",
        std::vec![
            to_scval(e, 100 * USDC),
            to_scval(e, 100 * USDC),
            to_scval(e, sellers.clone()),
            to_scval(e, a.session),
            to_scval(e, a.account.clone()),
        ],
    );
    let result = flatten(MandatePolicyClient::new(e, &a.policy).try_set_mandate(
        &(100 * USDC),
        &(100 * USDC),
        &sellers,
        &a.session,
        &a.account,
    ));
    assert_refused(result);
    assert_eq!(a.mandate().per_payment_cap, PER_PAYMENT_CAP);
}

// ---------------------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------------------

#[test]
fn safety_01_two_accounts_share_the_policy_contract_but_not_its_state() {
    let a = World::new();
    let b = a.sibling(key(11), key(12));

    a.pay(&a.seller, 5 * USDC).unwrap();
    a.pay(&a.seller, 5 * USDC).unwrap();
    assert_eq!(a.mandate().spent_in_period, 10 * USDC);
    assert_eq!(b.mandate().spent_in_period, 0);

    b.pay(&b.seller, 5 * USDC).expect("B has its own budget");
    assert_eq!(b.balance(&b.account), STARTING_BALANCE - 5 * USDC);

    // A's agent key means nothing in B.
    let result = b.pay_as(Some(&a.agent), b.session, &b.seller, USDC);
    assert_rejected(&b, result, SmartAccountError::UnauthorizedSigner as u32);
}

#[test]
fn safety_02_a_payment_that_fails_downstream_consumes_no_budget() {
    let w = World::new();
    // The owner moves almost everything out; 3 USDC are left.
    w.pay_as(Some(&w.owner), OWNER_RULE, &w.stranger, 97 * USDC)
        .unwrap();

    // 5 USDC is within the mandate, but the token refuses: not enough balance.
    assert_refused(w.pay(&w.seller, 5 * USDC));
    assert_eq!(w.mandate().spent_in_period, 0);
    assert_eq!(w.balance(&w.seller), 0);

    w.pay(&w.seller, 3 * USDC)
        .expect("what is left can still be spent");
    assert_eq!(w.mandate().spent_in_period, 3 * USDC);
}

#[test]
fn safety_03_lowering_the_period_cap_below_what_was_spent_blocks_until_rollover() {
    let w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.pay(&w.seller, 5 * USDC).unwrap();

    let sellers = vec![&w.e, w.seller.clone()];
    w.set_mandate(&w.owner, OWNER_RULE, 5 * USDC, 6 * USDC, &sellers)
        .unwrap();
    assert_eq!(
        w.mandate().spent_in_period,
        10 * USDC,
        "past payments still count"
    );

    let result = w.pay(&w.seller, 1);
    assert_rejected(&w, result, SpendingLimitError::SpendingLimitExceeded as u32);

    w.advance(PERIOD_LEDGERS);
    w.pay(&w.seller, 5 * USDC)
        .expect("a new period under the new cap");
    let result = w.pay(&w.seller, USDC + 1);
    assert_rejected(&w, result, SpendingLimitError::SpendingLimitExceeded as u32);
}

#[test]
fn safety_04_revoking_wipes_the_mandate_and_a_new_session_starts_clean() {
    let mut w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap();
    w.revoke_session(&w.owner, OWNER_RULE).unwrap();

    let policy = MandatePolicyClient::new(&w.e, &w.policy);
    let gone = flatten(policy.try_get_mandate(&w.session, &w.account));
    assert_rejected(&w, gone, MandateError::NotInstalled as u32);

    let agent = w.agent.clone();
    w.session = w
        .issue_session(&w.owner, OWNER_RULE, &agent, &w.default_params())
        .unwrap();
    assert_eq!(w.mandate().spent_in_period, 0);
    w.pay(&w.seller, 5 * USDC)
        .expect("the new session has its own budget");
}

#[test]
fn safety_05_the_period_is_a_rolling_window_not_a_reset() {
    let w = World::new();
    w.pay(&w.seller, 5 * USDC).unwrap(); // ledger 1000
    w.advance(60);
    w.pay(&w.seller, 5 * USDC).unwrap(); // ledger 1060
    w.advance(40); // ledger 1100: the first payment has just left the window

    assert_eq!(w.mandate().spent_in_period, 5 * USDC);
    w.pay(&w.seller, 5 * USDC).expect("5 + 5 fits in 12");
    let result = w.pay(&w.seller, 3 * USDC);
    assert_rejected(&w, result, SpendingLimitError::SpendingLimitExceeded as u32);

    w.advance(59); // ledger 1159: the payment of ledger 1060 is still inside
    let result = w.pay(&w.seller, 3 * USDC);
    assert_rejected(&w, result, SpendingLimitError::SpendingLimitExceeded as u32);
    w.advance(1); // ledger 1160: now it has left
    w.pay(&w.seller, 3 * USDC)
        .expect("only the payment of ledger 1100 still counts");
}

// ---------------------------------------------------------------------------------------
// Found by mutation testing: changes in the code that no test noticed
// ---------------------------------------------------------------------------------------

#[test]
fn attack_13_a_three_argument_token_call_that_is_not_a_transfer() {
    let w = World::new();
    let e = &w.e;
    // `burn_from(spender, from, amount)` has the shape of a transfer: three arguments, an
    // address first, an amount last. Read as one, it would be "pay 1 USDC to the seller",
    // which the mandate allows. It must be refused because of its name.
    w.authorize(
        Some(&w.agent),
        w.session,
        &w.usdc,
        "burn_from",
        std::vec![
            to_scval(e, w.account.clone()),
            to_scval(e, w.seller.clone()),
            to_scval(e, USDC),
        ],
    );
    let result = flatten(TokenClient::new(e, &w.usdc).try_burn_from(&w.account, &w.seller, &USDC));
    assert_rejected(&w, result, MandateError::NotATransfer as u32);
    w.assert_untouched(0);
}

#[test]
fn safety_06_the_seller_list_holds_exactly_the_maximum() {
    let w = World::new();
    let mut sellers = vec![&w.e];
    for _ in 0..MAX_SELLERS {
        sellers.push_back(Address::generate(&w.e));
    }
    let last = sellers.last_unchecked();

    w.set_mandate(&w.owner, OWNER_RULE, PER_PAYMENT_CAP, PERIOD_CAP, &sellers)
        .expect("a list of exactly MAX_SELLERS is accepted");
    w.pay(&last, USDC)
        .expect("the last seller of the list is allowed");

    sellers.push_back(Address::generate(&w.e));
    let result = w.set_mandate(&w.owner, OWNER_RULE, PER_PAYMENT_CAP, PERIOD_CAP, &sellers);
    assert_rejected(&w, result, MandateError::TooManySellers as u32);
    assert_eq!(w.mandate().sellers.len(), MAX_SELLERS);
}

// ---------------------------------------------------------------------------------------
// A payment declared under another contract's call
// ---------------------------------------------------------------------------------------

#[test]
fn attack_14_a_payment_nested_under_another_contracts_call() {
    let w = World::new();
    let e = &w.e;

    // The mandate counts a payment when it is authorized, which is before it runs. If the
    // agent could authorize a tree "call contract X, which then pays the seller", X could
    // return without paying and the budget would be spent on nothing (OpenZeppelin
    // stellar-contracts issue 908). A session cannot: its rule is scoped to the token, so
    // the call to X has no rule to stand on and the whole tree is refused.
    let call_to_another_contract = Context::Contract(ContractContext {
        contract: w.policy.clone(),
        fn_name: Symbol::new(e, "get_mandate"),
        args: vec![e, w.session.into_val(e), w.account.clone().into_val(e)],
    });
    let payment = Context::Contract(ContractContext {
        contract: w.usdc.clone(),
        fn_name: symbol_short!("transfer"),
        args: vec![
            e,
            w.account.clone().into_val(e),
            w.seller.clone().into_val(e),
            USDC.into_val(e),
        ],
    });

    for rules in [
        vec![e, w.session, w.session],
        // Claiming the owner rule for the outer call does not help: the owner did not sign.
        vec![e, OWNER_RULE, w.session],
    ] {
        let signature_payload = BytesN::from_array(e, &[7u8; 32]);
        let digest = AuthDigestPreimage {
            account: w.account.clone(),
            signature_payload: signature_payload.clone(),
            context_rule_ids: rules.clone(),
        }
        .digest(e);
        let mut signers: Map<Signer, Bytes> = Map::new(e);
        signers.set(
            w.signer_of(&w.agent),
            Bytes::from_array(e, &w.agent.sign(&digest.to_array()).to_bytes()),
        );

        let result = e.try_invoke_contract_check_auth::<SmartAccountError>(
            &w.account,
            &signature_payload,
            AuthPayload {
                signers,
                context_rule_ids: rules,
            }
            .into_val(e),
            &vec![e, call_to_another_contract.clone(), payment.clone()],
        );
        assert_eq!(result, Err(Ok(SmartAccountError::UnvalidatedContext)));
    }
    w.assert_untouched(0);
}
