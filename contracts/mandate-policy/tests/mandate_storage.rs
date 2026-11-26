//! How long the mandate's storage lives.
//!
//! Soroban storage is rented: every entry has a time to live and is archived when it runs
//! out. A mandate keeps two entries per session (its own terms, and the period history kept
//! by the reused spending limit policy). Both are renewed every time they are read, which
//! every payment does.
//!
//! The other suites give every entry a lifetime longer than the test, so renewal never
//! runs there. These tests use short lifetimes and look at the entries directly.

mod common;

use common::*;
use soroban_sdk::{contracttype, testutils::storage::Persistent as _, Address};
use stellar_accounts::policies::spending_limit::SpendingLimitStorageKey;

const DAY_IN_LEDGERS: u32 = 17_280;
/// What a read renews an entry to, and below which remaining lifetime it does so.
const RENEWED_TO: u32 = 30 * DAY_IN_LEDGERS;
const RENEWED_BELOW: u32 = 29 * DAY_IN_LEDGERS;
/// Lifetime of a new entry in these tests: well under `RENEWED_BELOW`.
const NEW_ENTRY_TTL: u32 = 100_000;
const LONG_SESSION: u32 = 1_500_000;

/// Same shape as the policy's private storage key.
#[contracttype]
enum MandateStorageKey {
    Mandate(Address, u32),
}

/// Remaining lifetime, in ledgers, of the mandate's terms and of its period history.
fn lifetimes(w: &World) -> (u32, u32) {
    w.e.as_contract(&w.policy, || {
        let storage = w.e.storage().persistent();
        (
            storage.get_ttl(&MandateStorageKey::Mandate(w.account.clone(), w.session)),
            storage.get_ttl(&SpendingLimitStorageKey::AccountContext(
                w.account.clone(),
                w.session,
            )),
        )
    })
}

#[test]
fn storage_01_a_new_mandate_starts_with_the_network_minimum() {
    let w = World::with(NEW_ENTRY_TTL, LONG_SESSION);

    // `get_ttl` counts the current ledger, hence the `- 1`.
    assert_eq!(lifetimes(&w), (NEW_ENTRY_TTL - 1, NEW_ENTRY_TTL - 1));
}

#[test]
fn storage_02_a_payment_renews_both_entries_to_thirty_days() {
    let w = World::with(NEW_ENTRY_TTL, LONG_SESSION);

    w.pay(&w.seller, USDC).expect("payment within the mandate");

    assert_eq!(lifetimes(&w), (RENEWED_TO, RENEWED_TO));
}

#[test]
fn storage_03_reading_the_mandate_renews_it_too() {
    let w = World::with(NEW_ENTRY_TTL, LONG_SESSION);

    w.mandate();

    assert_eq!(lifetimes(&w), (RENEWED_TO, RENEWED_TO));
}

#[test]
fn storage_04_no_renewal_while_more_than_twenty_nine_days_remain() {
    let w = World::with(NEW_ENTRY_TTL, LONG_SESSION);
    w.pay(&w.seller, USDC).expect("payment within the mandate");

    // Half a day later the entries still have more than 29 days: a payment leaves their
    // lifetime alone, so the agent does not pay rent on every purchase.
    let half_day = DAY_IN_LEDGERS / 2;
    w.advance(half_day);
    w.pay(&w.seller, USDC).expect("second payment");
    assert_eq!(
        lifetimes(&w),
        (RENEWED_TO - half_day, RENEWED_TO - half_day)
    );

    // Past the 29 day mark the next payment renews them.
    w.advance(DAY_IN_LEDGERS);
    assert!(RENEWED_TO - half_day - DAY_IN_LEDGERS < RENEWED_BELOW);
    w.pay(&w.seller, USDC).expect("third payment");
    assert_eq!(lifetimes(&w), (RENEWED_TO, RENEWED_TO));
}

#[test]
fn storage_05_an_idle_session_keeps_its_mandate() {
    let w = World::with(NEW_ENTRY_TTL, LONG_SESSION);
    w.pay(&w.seller, USDC).expect("payment within the mandate");

    // Nobody touches the session for longer than its storage lives. The test host brings
    // an archived entry back when it is read, with what it held; it does not come back
    // empty. So the mandate is neither lost nor loosened: the same terms apply.
    w.advance(RENEWED_TO + 10);

    assert_rejected(&w, w.pay(&w.seller, PER_PAYMENT_CAP + 1), 4105);
    assert_rejected(&w, w.pay(&w.stranger, USDC), 4106);
    w.pay(&w.seller, USDC).expect("payment within the mandate");

    let mandate = w.mandate();
    assert_eq!(mandate.per_payment_cap, PER_PAYMENT_CAP);
    assert_eq!(mandate.period_cap, PERIOD_CAP);
    assert_eq!(mandate.spent_in_period, USDC);
    assert_eq!(lifetimes(&w), (RENEWED_TO, RENEWED_TO));
}
