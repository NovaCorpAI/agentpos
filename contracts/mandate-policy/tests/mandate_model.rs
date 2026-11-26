//! Model test: random sequences of payments, checked one by one against a reference model.
//!
//! The model is the mandate written the naive way: a list of accepted payments and a
//! handful of conditions. Every operation the generator produces (a payment of any amount,
//! to any party, signed by anyone, at any ledger) must get the same answer from the
//! contracts and from the model, and the balances and the period total must match after
//! each step.
//!
//! Sequences come from a fixed list of seeds, so a failure reproduces exactly: the panic
//! message names the seed and the step.
//!
//! Run with `cargo test -p agentpos-mandate-policy --test mandate_model`.

extern crate std;

mod common;

use common::*;

const SEEDS: [u64; 8] = [1, 2, 3, 5, 8, 13, 21, 34];
const STEPS: usize = 40;
/// Half of the sequences run under the default mandate (12 USDC per period), where the
/// period cap is what usually says no. The other half get a looser period cap, so the
/// other rules get their share of the decisions.
const LOOSE_PERIOD_CAP: i128 = 30 * USDC;

/// xorshift64*: small, deterministic, good enough to explore the input space.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Payee {
    Seller,
    NotAllowed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SignedBy {
    Agent,
    UnknownKey,
    Nobody,
}

/// The mandate, written the naive way.
struct Model {
    ledger: u32,
    session_valid_until: u32,
    period_cap: i128,
    /// Accepted payments as `(ledger, amount)`.
    accepted: std::vec::Vec<(u32, i128)>,
}

impl Model {
    fn spent_in_period(&self) -> i128 {
        self.accepted
            .iter()
            .filter(|(ledger, _)| *ledger + PERIOD_LEDGERS > self.ledger)
            .map(|(_, amount)| *amount)
            .sum()
    }

    fn total(&self) -> i128 {
        self.accepted.iter().map(|(_, amount)| *amount).sum()
    }

    fn allows(&self, amount: i128, payee: Payee, signed_by: SignedBy) -> bool {
        signed_by == SignedBy::Agent
            && self.ledger <= self.session_valid_until
            && payee == Payee::Seller
            && amount > 0
            && amount <= PER_PAYMENT_CAP
            && self.spent_in_period() + amount <= self.period_cap
    }
}

/// Amounts cluster around the interesting edges: zero, one unit, the cap per payment and
/// what is left of the period, plus negative and plain random values.
fn pick_amount(rng: &mut Rng, left_in_period: i128) -> i128 {
    match rng.below(10) {
        0 => 0,
        1 => 1,
        2 => PER_PAYMENT_CAP,
        3 => PER_PAYMENT_CAP + 1,
        4 => left_in_period,
        5 => left_in_period + 1,
        6 => -(rng.below(3 * USDC as u64) as i128) - 1,
        _ => rng.below(4 * USDC as u64) as i128,
    }
}

/// Returns `(accepted, rejected)` for the sequence of `seed`.
fn run(seed: u64, period_cap: i128) -> (usize, usize) {
    let w = World::new();
    let sellers = soroban_sdk::vec![&w.e, w.seller.clone()];
    w.set_mandate(&w.owner, OWNER_RULE, PER_PAYMENT_CAP, period_cap, &sellers)
        .unwrap();
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut model = Model {
        ledger: START_LEDGER,
        session_valid_until: START_LEDGER + SESSION_LEDGERS,
        period_cap,
        accepted: std::vec::Vec::new(),
    };
    let unknown = key(200);
    let mut rejected = 0;

    for step in 0..STEPS {
        // Time moves in jumps that land before, on and after the period boundary.
        let jump = match rng.below(20) {
            0 => 0,
            1 => 1,
            2 => PERIOD_LEDGERS - 1,
            3 => PERIOD_LEDGERS,
            _ => rng.below(14) as u32,
        };
        w.advance(jump);
        model.ledger += jump;

        let amount = pick_amount(&mut rng, period_cap - model.spent_in_period());
        let payee = if rng.below(6) == 0 {
            Payee::NotAllowed
        } else {
            Payee::Seller
        };
        let signed_by = match rng.below(10) {
            0 => SignedBy::UnknownKey,
            1 => SignedBy::Nobody,
            _ => SignedBy::Agent,
        };

        let to = match payee {
            Payee::Seller => &w.seller,
            Payee::NotAllowed => &w.stranger,
        };
        let signing_key = match signed_by {
            SignedBy::Agent => Some(&w.agent),
            SignedBy::UnknownKey => Some(&unknown),
            SignedBy::Nobody => None,
        };

        let expected = model.allows(amount, payee, signed_by);
        let actual = w.pay_as(signing_key, w.session, to, amount);
        let context = std::format!(
            "seed {seed}, step {step}: ledger {}, pay {amount} to {payee:?} signed by \
             {signed_by:?}, {} spent in the period",
            model.ledger,
            model.spent_in_period()
        );
        assert_eq!(
            actual.is_ok(),
            expected,
            "{context}: contracts said {actual:?}"
        );

        if expected {
            model.accepted.push((model.ledger, amount));
        } else {
            rejected += 1;
        }
        assert_eq!(
            w.balance(&w.account),
            STARTING_BALANCE - model.total(),
            "{context}"
        );
        assert_eq!(w.balance(&w.seller), model.total(), "{context}");
        assert_eq!(w.balance(&w.stranger), 0, "{context}");
        assert_eq!(
            w.mandate().spent_in_period,
            model.spent_in_period(),
            "{context}"
        );
        assert!(model.spent_in_period() <= period_cap, "{context}");
    }

    (model.accepted.len(), rejected)
}

#[test]
fn model_agrees_with_the_contracts_on_random_sequences() {
    let (mut accepted, mut rejected) = (0, 0);
    for (i, seed) in SEEDS.into_iter().enumerate() {
        let period_cap = if i % 2 == 0 {
            PERIOD_CAP
        } else {
            LOOSE_PERIOD_CAP
        };
        let (a, r) = run(seed, period_cap);
        let cap = period_cap / USDC;
        std::println!("seed {seed}, {cap} USDC per period: {a} accepted, {r} rejected");
        accepted += a;
        rejected += r;
    }
    std::println!("total: {accepted} accepted, {rejected} rejected");
    // The generator must exercise both answers, or the test proves nothing.
    assert!(accepted >= 60, "only {accepted} accepted payments");
    assert!(rejected >= 60, "only {rejected} rejected payments");
}
