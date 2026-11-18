//! The human's smart account.
//!
//! This is an OpenZeppelin `stellar-accounts` smart account with one opinion: it is born
//! with a single `Default` context rule that belongs to the owner (the human). Everything
//! else is composition:
//!
//! - **Owner-only operations.** Every management function (`add_context_rule`,
//!   `remove_context_rule`, `add_policy`, `execute`, ...) requires the account's own
//!   authorization. Authorizing a call *to the account* needs a rule that matches that
//!   context, and only the owner's `Default` rule does. A session rule is scoped to the
//!   USDC contract, so a session key can never issue, extend or revoke a session, nor
//!   change the policy.
//! - **Issue session** is `add_context_rule(CallContract(usdc), name, valid_until,
//!   [session key], {mandate policy: MandateParams})`.
//! - **Revoke session** is `remove_context_rule(rule_id)`. It takes effect in the same
//!   ledger: the next payment finds no rule.
//! - **Session expiry** is the rule's `valid_until` ledger, checked by the account before
//!   any policy runs.
//!
//! The spending rules themselves live in the `agentpos-mandate-policy` contract.
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    add_context_rule, do_check_auth, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType,
    ExecutionEntryPoint, Signer, SmartAccount, SmartAccountError,
};

#[contract]
pub struct MandateAccount;

#[contractimpl]
impl MandateAccount {
    /// Creates the account with its owner rule (rule id 0, `Default`, no expiry).
    ///
    /// `owners` are the human's signers. All of them must sign an owner operation; use a
    /// threshold policy if the owner wants M-of-N. An empty list is rejected
    /// (`NoSignersAndPolicies`), because an account without an owner rule can never be
    /// managed again.
    pub fn __constructor(e: Env, owners: Vec<Signer>) {
        add_context_rule(
            &e,
            &ContextRuleType::Default,
            &String::from_str(&e, "owner"),
            None,
            &owners,
            &Map::new(&e),
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for MandateAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for MandateAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for MandateAccount {}
