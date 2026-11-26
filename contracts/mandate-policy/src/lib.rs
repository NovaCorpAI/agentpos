//! The AgentPOS mandate as a smart account policy.
//!
//! A mandate is what a person lets their buying agent do: how much per payment, how much
//! per period, and which sellers. Off-chain, AgentPOS checks it before every signature.
//! This contract is the on-chain counterpart: it runs inside the smart account's
//! `__check_auth`, so a payment that breaks the mandate is refused by the network even if
//! the session key has leaked.
//!
//! The policy is attached to a session context rule scoped to one token contract
//! (`CallContract(usdc)`). For every authorization it requires, in order:
//!
//! 1. every signer of the session rule has signed;
//! 2. the call is `transfer(from = the account, to, amount)`, nothing else on the token;
//! 3. `amount > 0` and `amount <= per_payment_cap`;
//! 4. `to` is in the seller allowlist;
//! 5. the rolling total over `period_ledgers` stays within `period_cap` (the state and
//!    the rules of OpenZeppelin's spending limit policy).
//!
//! Authorizing a payment emits no contract event. An x402 facilitator accepts a payment
//! only when the token's `transfer` is the single contract event of the transaction, so
//! anything published from inside `__check_auth` would make the payment unpayable through
//! one. The token's own `transfer` event is the record of the payment.
//!
//! Session expiry and revocation are enforced by the account before this policy runs:
//! expiry is the rule's `valid_until`, revocation is removing the rule.
//!
//! Amounts are integers in the token's smallest unit (USDC on Stellar has 7 decimals).
//!
//! One deployment serves every account: all state is keyed by
//! `(smart_account, context_rule_id)` and every write requires that account's
//! authorization.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::{
        spending_limit::{
            self, SpendingEntry, SpendingLimitAccountParams, SpendingLimitData, SpendingLimitError,
            SpendingLimitStorageKey, MAX_HISTORY_ENTRIES,
        },
        Policy,
    },
    smart_account::{ContextRule, Signer, SmartAccountClient},
};

const DAY_IN_LEDGERS: u32 = 17280;
const MANDATE_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const MANDATE_TTL_THRESHOLD: u32 = MANDATE_EXTEND_AMOUNT - DAY_IN_LEDGERS;

/// Maximum number of sellers in one mandate. Keeps the entry small and the check cheap.
pub const MAX_SELLERS: u32 = 32;

/// Installation parameters, passed as the policy's value in `add_context_rule`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MandateParams {
    /// Maximum amount of a single payment, in the token's smallest unit.
    pub per_payment_cap: i128,
    /// Maximum total over the rolling period, in the token's smallest unit.
    pub period_cap: i128,
    /// Length of the rolling period, in ledgers (17280 is about one day).
    pub period_ledgers: u32,
    /// Addresses the agent may pay.
    pub sellers: Vec<Address>,
}

/// Current state of a mandate, for wallets and stores that want to read it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MandateState {
    pub per_payment_cap: i128,
    pub period_cap: i128,
    pub period_ledgers: u32,
    /// Total spent inside the rolling period as of the current ledger.
    pub spent_in_period: i128,
    pub sellers: Vec<Address>,
}

#[contracttype]
#[derive(Clone)]
struct MandateData {
    per_payment_cap: i128,
    sellers: Vec<Address>,
}

#[contracttype]
enum MandateStorageKey {
    /// Mandate of a smart account's context rule.
    Mandate(Address, u32),
}

/// Machine-readable rejection codes. An over-period payment is rejected with the code of
/// the OpenZeppelin policy whose state it is, `SpendingLimitExceeded = 3221`.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MandateError {
    /// No mandate is installed for this account and context rule.
    NotInstalled = 4100,
    /// Caps, period or seller list are invalid.
    InvalidParams = 4101,
    /// More than `MAX_SELLERS` sellers.
    TooManySellers = 4102,
    /// The mandate only authorizes `transfer(from = account, to, amount)` on the token.
    NotATransfer = 4103,
    /// The amount is zero or negative.
    NonPositiveAmount = 4104,
    /// The amount is over the cap per payment.
    OverPaymentCap = 4105,
    /// The recipient is not in the seller allowlist.
    SellerNotAllowed = 4106,
    /// Not every signer of the session rule signed.
    MissingSessionSignature = 4107,
}

/// Emitted when the owner changes the mandate.
#[contractevent]
#[derive(Clone)]
pub struct MandateChanged {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub per_payment_cap: i128,
    pub period_cap: i128,
    pub sellers: Vec<Address>,
}

#[contract]
pub struct MandatePolicy;

#[contractimpl]
impl Policy for MandatePolicy {
    type AccountParams = MandateParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        // Checks first (reads only). Nothing is written before the account's
        // authorization further down.

        // A rule with policies defers signer validation to the policy. The session key
        // must have signed; with several session signers, all of them.
        if authenticated_signers.is_empty()
            || authenticated_signers.len() != context_rule.signers.len()
        {
            panic_with_error!(e, MandateError::MissingSessionSignature)
        }

        let mandate = read_mandate(e, context_rule.id, &smart_account);
        let (seller, amount) = parse_transfer(e, &context, &smart_account);

        if amount <= 0 {
            panic_with_error!(e, MandateError::NonPositiveAmount)
        }
        if amount > mandate.per_payment_cap {
            panic_with_error!(e, MandateError::OverPaymentCap)
        }
        if !mandate.sellers.contains(&seller) {
            panic_with_error!(e, MandateError::SellerNotAllowed)
        }

        // Every write below needs the account's authorization. The account is the direct
        // caller here, from inside its `__check_auth`.
        smart_account.require_auth();

        enforce_period(e, context_rule.id, &smart_account, amount);
    }

    fn install(
        e: &Env,
        install_params: MandateParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        validate_caps(e, install_params.per_payment_cap, install_params.period_cap);
        validate_sellers(e, &install_params.sellers);

        // Requires the account's authorization and a `CallContract` rule, which pins the
        // mandate to one token; rejects a zero period and a second install.
        spending_limit::install(
            e,
            &SpendingLimitAccountParams {
                spending_limit: install_params.period_cap,
                period_ledgers: install_params.period_ledgers,
            },
            &context_rule,
            &smart_account,
        );

        write_mandate(
            e,
            context_rule.id,
            &smart_account,
            &MandateData {
                per_payment_cap: install_params.per_payment_cap,
                sellers: install_params.sellers.clone(),
            },
        );

        MandateChanged {
            smart_account,
            context_rule_id: context_rule.id,
            per_payment_cap: install_params.per_payment_cap,
            period_cap: install_params.period_cap,
            sellers: install_params.sellers,
        }
        .publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        // Requires the account's authorization; panics when not installed.
        spending_limit::uninstall(e, &context_rule, &smart_account);
        e.storage()
            .persistent()
            .remove(&MandateStorageKey::Mandate(smart_account, context_rule.id));
    }
}

#[contractimpl]
impl MandatePolicy {
    /// Returns the mandate of `smart_account` for `context_rule_id`.
    pub fn get_mandate(e: &Env, context_rule_id: u32, smart_account: Address) -> MandateState {
        let mandate = read_mandate(e, context_rule_id, &smart_account);
        let limit = spending_limit::get_spending_limit_data(e, context_rule_id, &smart_account);
        MandateState {
            per_payment_cap: mandate.per_payment_cap,
            period_cap: limit.spending_limit,
            period_ledgers: limit.period_ledgers,
            spent_in_period: spent_in_period(e, &limit),
            sellers: mandate.sellers,
        }
    }

    /// Replaces the caps and the seller allowlist. Owner only: it requires the account's
    /// authorization for a call to this contract, which a session rule (scoped to the
    /// token) cannot give. Payments already made in the current period still count.
    pub fn set_mandate(
        e: &Env,
        per_payment_cap: i128,
        period_cap: i128,
        sellers: Vec<Address>,
        context_rule_id: u32,
        smart_account: Address,
    ) {
        // Checks and reads first; nothing is written before the authorization below.
        validate_caps(e, per_payment_cap, period_cap);
        validate_sellers(e, &sellers);

        // Panics with `NotInstalled` when there is no mandate to change.
        read_mandate(e, context_rule_id, &smart_account);

        // The period cap lives in the reused spending limit policy and is changed through
        // its public function, never by writing its storage. That function wants the rule
        // itself, so it is read from the account (`ContextRuleNotFound` when it is gone).
        let context_rule =
            SmartAccountClient::new(e, &smart_account).get_context_rule(&context_rule_id);

        // This is the authorization of `set_mandate`: `set_spending_limit` requires the
        // account's authorization for this call before it writes. The host accepts one
        // `require_auth` per address and call, so it is not repeated here.
        spending_limit::set_spending_limit(e, period_cap, &context_rule, &smart_account);

        write_mandate(
            e,
            context_rule_id,
            &smart_account,
            &MandateData {
                per_payment_cap,
                sellers: sellers.clone(),
            },
        );

        MandateChanged {
            smart_account,
            context_rule_id,
            per_payment_cap,
            period_cap,
            sellers,
        }
        .publish(e);
    }
}

fn read_mandate(e: &Env, context_rule_id: u32, smart_account: &Address) -> MandateData {
    let key = MandateStorageKey::Mandate(smart_account.clone(), context_rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .inspect(|_: &MandateData| {
            e.storage()
                .persistent()
                .extend_ttl(&key, MANDATE_TTL_THRESHOLD, MANDATE_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, MandateError::NotInstalled))
}

fn write_mandate(e: &Env, context_rule_id: u32, smart_account: &Address, data: &MandateData) {
    let key = MandateStorageKey::Mandate(smart_account.clone(), context_rule_id);
    e.storage().persistent().set(&key, data);
}

fn validate_caps(e: &Env, per_payment_cap: i128, period_cap: i128) {
    if per_payment_cap <= 0 || period_cap < per_payment_cap {
        panic_with_error!(e, MandateError::InvalidParams)
    }
}

fn validate_sellers(e: &Env, sellers: &Vec<Address>) {
    if sellers.is_empty() {
        panic_with_error!(e, MandateError::InvalidParams)
    }
    if sellers.len() > MAX_SELLERS {
        panic_with_error!(e, MandateError::TooManySellers)
    }
    for i in 0..sellers.len() {
        for j in (i + 1)..sellers.len() {
            if sellers.get_unchecked(i) == sellers.get_unchecked(j) {
                panic_with_error!(e, MandateError::InvalidParams)
            }
        }
    }
}

/// Returns `(to, amount)` when `context` is `transfer(from = smart_account, to, amount)`.
/// Any other function on the token (`approve`, `burn`, `transfer_from`, ...) is refused.
fn parse_transfer(e: &Env, context: &Context, smart_account: &Address) -> (Address, i128) {
    if let Context::Contract(ContractContext { fn_name, args, .. }) = context {
        if fn_name == &symbol_short!("transfer") && args.len() == 3 {
            let from = Address::try_from_val(e, &args.get_unchecked(0));
            let to = Address::try_from_val(e, &args.get_unchecked(1));
            let amount = i128::try_from_val(e, &args.get_unchecked(2));
            if let (Ok(from), Ok(to), Ok(amount)) = (from, to, amount) {
                if &from == smart_account {
                    return (to, amount);
                }
            }
        }
    }
    panic_with_error!(e, MandateError::NotATransfer)
}

/// Rolling period cap: drops the payments that left the window, refuses the payment when
/// the total would pass the cap, and records it otherwise.
///
/// This is `spending_limit::enforce` of OpenZeppelin `stellar-accounts` 0.8.0, on the same
/// storage entry and with the same error codes, without its `SpendingLimitEnforced` event
/// (see the module documentation). Installing, changing and removing the cap still go
/// through that policy's own functions. The library version is pinned: a new version must
/// be compared against this function before it is adopted.
fn enforce_period(e: &Env, context_rule_id: u32, smart_account: &Address, amount: i128) {
    let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    // Panics with `SmartAccountNotInstalled` when the entry is missing; renews its TTL.
    let mut data = spending_limit::get_spending_limit_data(e, context_rule_id, smart_account);
    let current_ledger = e.ledger().sequence();

    let cutoff = current_ledger.saturating_sub(data.period_ledgers);
    while let Some(entry) = data.spending_history.get(0) {
        if entry.ledger_sequence > cutoff {
            break;
        }
        data.cached_total_spent -= entry.amount;
        data.spending_history.pop_front();
    }

    if data.cached_total_spent + amount > data.spending_limit {
        panic_with_error!(e, SpendingLimitError::SpendingLimitExceeded)
    }
    if data.spending_history.len() >= MAX_HISTORY_ENTRIES {
        panic_with_error!(e, SpendingLimitError::HistoryCapacityExceeded)
    }

    data.spending_history.push_back(SpendingEntry {
        amount,
        ledger_sequence: current_ledger,
    });
    data.cached_total_spent += amount;
    e.storage().persistent().set(&key, &data);
}

/// Sum of the payments still inside the rolling period at the current ledger.
fn spent_in_period(e: &Env, limit: &SpendingLimitData) -> i128 {
    let cutoff = e.ledger().sequence().saturating_sub(limit.period_ledgers);
    let mut total = 0i128;
    for entry in limit.spending_history.iter() {
        if entry.ledger_sequence > cutoff {
            total += entry.amount;
        }
    }
    total
}
