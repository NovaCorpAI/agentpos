//! Shared harness for the mandate tests.
//!
//! Nothing here mocks the authorization of a payment or of an owner operation. Each call
//! carries a real Soroban authorization entry for the smart account, signed with an Ed25519
//! key, and goes through the host into the account's `__check_auth`, the verifier and the
//! policy. The token is a Stellar Asset Contract, the same kind of contract as USDC on
//! Stellar. Only the setup (minting the balance) uses mocked authorization.
//!
//! By default the three contracts run as native Rust. With `AGENTPOS_WASM_DIR` set to the
//! folder that holds the built `.wasm` files, the same tests run against those artifacts,
//! which is what gets deployed.
#![allow(dead_code)]

extern crate std;

use std::{cell::Cell, path::PathBuf};

use agentpos_ed25519_verifier::Ed25519Verifier;
use agentpos_mandate_account::{MandateAccount, MandateAccountClient};
use agentpos_mandate_policy::{MandateParams, MandatePolicy, MandatePolicyClient, MandateState};
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    map,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        Hash as XdrHash, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs,
        Limits, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, Map, String, TryFromVal, Val, Vec,
};
use stellar_accounts::smart_account::{AuthDigestPreimage, AuthPayload, ContextRuleType, Signer};

/// USDC has 7 decimals on Stellar.
pub const USDC: i128 = 10_000_000;
pub const START_LEDGER: u32 = 1_000;
pub const PERIOD_LEDGERS: u32 = 100;
pub const SESSION_LEDGERS: u32 = 500;
pub const PER_PAYMENT_CAP: i128 = 5 * USDC;
pub const PERIOD_CAP: i128 = 12 * USDC;
pub const OWNER_RULE: u32 = 0;
pub const STARTING_BALANCE: i128 = 100 * USDC;

/// `Ok` with the value, or `Err` with the error the network returned, as text.
pub type Rejected<T> = Result<T, std::string::String>;

/// A contract call the smart account is asked to authorize.
#[derive(Clone)]
pub struct Call {
    pub contract: Address,
    pub fn_name: &'static str,
    pub args: std::vec::Vec<ScVal>,
}

pub struct World {
    pub e: Env,
    pub account: Address,
    pub policy: Address,
    pub usdc: Address,
    pub verifier: Address,
    pub owner: SigningKey,
    pub agent: SigningKey,
    pub seller: Address,
    pub other_seller: Address,
    pub stranger: Address,
    /// Context rule id of the agent's session.
    pub session: u32,
    /// How long a session issued in this world lasts, in ledgers.
    pub session_ledgers: u32,
    nonce: Cell<i64>,
}

pub fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn to_scval<T: IntoVal<Env, Val>>(e: &Env, value: T) -> ScVal {
    ScVal::try_from_val(e, &value.into_val(e)).unwrap()
}

/// Folder with the built `.wasm` files, when the tests must run against them.
pub fn wasm_dir() -> Option<PathBuf> {
    std::env::var_os("AGENTPOS_WASM_DIR").map(PathBuf::from)
}

fn wasm(dir: &std::path::Path, name: &str) -> std::vec::Vec<u8> {
    let path = dir.join(name);
    std::fs::read(&path).unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()))
}

fn external(e: &Env, verifier: &Address, signing_key: &SigningKey) -> Signer {
    Signer::External(
        verifier.clone(),
        Bytes::from_array(e, signing_key.verifying_key().as_bytes()),
    )
}

impl World {
    /// An account that holds 100 USDC, owned by `owner`, with one session for `agent`:
    /// up to 5 USDC per payment, 12 USDC per 100 ledgers, one allowed seller, 500 ledgers.
    pub fn new() -> Self {
        Self::with(1_000_000, SESSION_LEDGERS)
    }

    /// Same world, with a chosen lifetime for new ledger entries and for the session. The
    /// default keeps every entry alive for the whole test; the storage tests shorten it.
    pub fn with(min_entry_ttl: u32, session_ledgers: u32) -> Self {
        let e = Env::default();
        e.ledger().with_mut(|l| {
            l.sequence_number = START_LEDGER;
            l.min_persistent_entry_ttl = min_entry_ttl;
            l.min_temp_entry_ttl = min_entry_ttl;
            l.max_entry_ttl = 2_000_000;
        });

        let owner = key(1);
        let agent = key(2);
        let (verifier, policy) = match wasm_dir() {
            Some(dir) => (
                e.register(wasm(&dir, "agentpos_ed25519_verifier.wasm").as_slice(), ()),
                e.register(wasm(&dir, "agentpos_mandate_policy.wasm").as_slice(), ()),
            ),
            None => (
                e.register(Ed25519Verifier, ()),
                e.register(MandatePolicy, ()),
            ),
        };

        let issuer = Address::generate(&e);
        let usdc = e.register_stellar_asset_contract_v2(issuer).address();

        let mut world = World {
            seller: Address::generate(&e),
            other_seller: Address::generate(&e),
            stranger: Address::generate(&e),
            account: verifier.clone(),
            e,
            policy,
            usdc,
            verifier,
            owner,
            agent,
            session: 0,
            session_ledgers,
            nonce: Cell::new(0),
        };
        world.account = world.new_account(&world.owner, STARTING_BALANCE);
        world.session = world
            .issue_session(
                &world.owner,
                OWNER_RULE,
                &world.agent,
                &world.default_params(),
            )
            .expect("the owner issues the session");
        world
    }

    /// Deploys another mandate account owned by `owner_key`, holding `balance` USDC.
    pub fn new_account(&self, owner_key: &SigningKey, balance: i128) -> Address {
        let e = &self.e;
        let owners = vec![e, self.signer_of(owner_key)];
        let account = match wasm_dir() {
            Some(dir) => e.register(
                wasm(&dir, "agentpos_mandate_account.wasm").as_slice(),
                (owners,),
            ),
            None => e.register(MandateAccount, (owners,)),
        };
        if balance > 0 {
            e.mock_all_auths();
            StellarAssetClient::new(e, &self.usdc).mint(&account, &balance);
            e.set_auths(&[]);
        }
        account
    }

    /// A second account in the same network, with its own owner and its own agent session,
    /// sharing the token, the verifier and the policy contract with this one.
    pub fn sibling(&self, owner: SigningKey, agent: SigningKey) -> World {
        let mut world = World {
            e: self.e.clone(),
            account: self.account.clone(),
            policy: self.policy.clone(),
            usdc: self.usdc.clone(),
            verifier: self.verifier.clone(),
            owner,
            agent,
            seller: self.seller.clone(),
            other_seller: self.other_seller.clone(),
            stranger: self.stranger.clone(),
            session: 0,
            session_ledgers: self.session_ledgers,
            nonce: Cell::new(1_000_000),
        };
        world.account = world.new_account(&world.owner, STARTING_BALANCE);
        world.session = world
            .issue_session(
                &world.owner,
                OWNER_RULE,
                &world.agent,
                &world.default_params(),
            )
            .expect("the sibling owner issues its session");
        world
    }

    pub fn default_params(&self) -> MandateParams {
        MandateParams {
            per_payment_cap: PER_PAYMENT_CAP,
            period_cap: PERIOD_CAP,
            period_ledgers: PERIOD_LEDGERS,
            sellers: vec![&self.e, self.seller.clone()],
        }
    }

    pub fn signer_of(&self, signing_key: &SigningKey) -> Signer {
        external(&self.e, &self.verifier, signing_key)
    }

    pub fn transfer_call(&self, to: &Address, amount: i128) -> Call {
        let e = &self.e;
        Call {
            contract: self.usdc.clone(),
            fn_name: "transfer",
            args: std::vec![
                to_scval(e, self.account.clone()),
                to_scval(e, to.clone()),
                to_scval(e, amount)
            ],
        }
    }

    /// Builds the smart account's authorization entry for `submitted` under
    /// `submitted_rule`, carrying a signature that `signing_key` made over `signed` under
    /// `signed_rule`. An honest client signs exactly what it submits; the adversarial tests
    /// make the two differ.
    pub fn forged_entry(
        &self,
        signing_key: Option<&SigningKey>,
        signed_rule: u32,
        signed: &Call,
        submitted_rule: u32,
        submitted: &Call,
    ) -> SorobanAuthorizationEntry {
        let e = &self.e;
        let nonce = self.nonce.get() + 1;
        self.nonce.set(nonce);
        let expiration = e.ledger().sequence() + 10;

        let invocation = |call: &Call| SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: (&call.contract).into(),
                function_name: call.fn_name.try_into().unwrap(),
                args: call.args.clone().try_into().unwrap(),
            }),
            sub_invocations: VecM::default(),
        };

        // What the host hands to `__check_auth` as `signature_payload`.
        let host_preimage =
            HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
                network_id: XdrHash(e.ledger().get().network_id),
                nonce,
                signature_expiration_ledger: expiration,
                invocation: invocation(signed),
            });
        let xdr = host_preimage.to_xdr(Limits::none()).unwrap();
        let signature_payload: BytesN<32> =
            e.crypto().sha256(&Bytes::from_slice(e, &xdr)).to_bytes();

        // What the signer actually signs: the digest bound to the account and the rule.
        let digest = AuthDigestPreimage {
            account: self.account.clone(),
            signature_payload,
            context_rule_ids: vec![e, signed_rule],
        }
        .digest(e);

        let mut signers: Map<Signer, Bytes> = Map::new(e);
        if let Some(signing_key) = signing_key {
            let signature = signing_key.sign(&digest.to_array()).to_bytes();
            signers.set(
                self.signer_of(signing_key),
                Bytes::from_array(e, &signature),
            );
        }

        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: (&self.account).into(),
                nonce,
                signature_expiration_ledger: expiration,
                signature: to_scval(
                    e,
                    AuthPayload {
                        signers,
                        context_rule_ids: vec![e, submitted_rule],
                    },
                ),
            }),
            root_invocation: invocation(submitted),
        }
    }

    /// The entry an honest client builds: it signs exactly what it submits.
    pub fn signed_entry(
        &self,
        signing_key: Option<&SigningKey>,
        rule: u32,
        call: &Call,
    ) -> SorobanAuthorizationEntry {
        self.forged_entry(signing_key, rule, call, rule, call)
    }

    /// Replaces the host's authorizations with a single entry for the smart account:
    /// `signing_key` signs the call `contract.fn_name(args)` under context rule `rule`.
    pub fn authorize(
        &self,
        signing_key: Option<&SigningKey>,
        rule: u32,
        contract: &Address,
        fn_name: &'static str,
        args: std::vec::Vec<ScVal>,
    ) {
        let call = Call {
            contract: contract.clone(),
            fn_name,
            args,
        };
        self.e
            .set_auths(&[self.signed_entry(signing_key, rule, &call)]);
    }

    /// Submits the USDC transfer with whatever authorization entries are currently set.
    pub fn submit_transfer(&self, to: &Address, amount: i128) -> Rejected<()> {
        flatten(TokenClient::new(&self.e, &self.usdc).try_transfer(&self.account, to, &amount))
    }

    /// A USDC payment from the account, signed by `signing_key` under `rule`.
    pub fn pay_as(
        &self,
        signing_key: Option<&SigningKey>,
        rule: u32,
        to: &Address,
        amount: i128,
    ) -> Rejected<()> {
        let call = self.transfer_call(to, amount);
        self.e
            .set_auths(&[self.signed_entry(signing_key, rule, &call)]);
        self.submit_transfer(to, amount)
    }

    /// The agent pays with its session key.
    pub fn pay(&self, to: &Address, amount: i128) -> Rejected<()> {
        self.pay_as(Some(&self.agent), self.session, to, amount)
    }

    /// Owner operation "issue session": a rule scoped to USDC transfers, with the session
    /// key as signer, the mandate as policy and an expiry.
    pub fn issue_session(
        &self,
        signing_key: &SigningKey,
        rule: u32,
        session_key: &SigningKey,
        params: &MandateParams,
    ) -> Rejected<u32> {
        let signers = vec![&self.e, self.signer_of(session_key)];
        self.issue_session_with(signing_key, rule, &signers, params)
    }

    /// Same as `issue_session`, with any list of session signers.
    pub fn issue_session_with(
        &self,
        signing_key: &SigningKey,
        rule: u32,
        signers: &Vec<Signer>,
        params: &MandateParams,
    ) -> Rejected<u32> {
        let e = &self.e;
        let context_type = ContextRuleType::CallContract(self.usdc.clone());
        let name = String::from_str(e, "agent session");
        let valid_until = Some(e.ledger().sequence() + self.session_ledgers);
        let policies: Map<Address, Val> =
            map![e, (self.policy.clone(), params.clone().into_val(e))];

        self.authorize(
            Some(signing_key),
            rule,
            &self.account,
            "add_context_rule",
            std::vec![
                to_scval(e, context_type.clone()),
                to_scval(e, name.clone()),
                to_scval(e, valid_until),
                to_scval(e, signers.clone()),
                to_scval(e, policies.clone()),
            ],
        );
        flatten(
            MandateAccountClient::new(e, &self.account).try_add_context_rule(
                &context_type,
                &name,
                &valid_until,
                signers,
                &policies,
            ),
        )
        .map(|rule| rule.id)
    }

    /// Owner operation "revoke session".
    pub fn revoke_session(&self, signing_key: &SigningKey, rule: u32) -> Rejected<()> {
        let e = &self.e;
        self.authorize(
            Some(signing_key),
            rule,
            &self.account,
            "remove_context_rule",
            std::vec![to_scval(e, self.session)],
        );
        flatten(MandateAccountClient::new(e, &self.account).try_remove_context_rule(&self.session))
    }

    /// Owner operation "set policy".
    pub fn set_mandate(
        &self,
        signing_key: &SigningKey,
        rule: u32,
        per_payment_cap: i128,
        period_cap: i128,
        sellers: &Vec<Address>,
    ) -> Rejected<()> {
        let e = &self.e;
        self.authorize(
            Some(signing_key),
            rule,
            &self.policy,
            "set_mandate",
            std::vec![
                to_scval(e, per_payment_cap),
                to_scval(e, period_cap),
                to_scval(e, sellers.clone()),
                to_scval(e, self.session),
                to_scval(e, self.account.clone()),
            ],
        );
        flatten(MandatePolicyClient::new(e, &self.policy).try_set_mandate(
            &per_payment_cap,
            &period_cap,
            sellers,
            &self.session,
            &self.account,
        ))
    }

    pub fn mandate(&self) -> MandateState {
        MandatePolicyClient::new(&self.e, &self.policy).get_mandate(&self.session, &self.account)
    }

    pub fn balance(&self, of: &Address) -> i128 {
        TokenClient::new(&self.e, &self.usdc).balance(of)
    }

    pub fn advance(&self, ledgers: u32) {
        self.e.ledger().with_mut(|l| l.sequence_number += ledgers);
    }

    /// Asserts that a rejected payment moved nothing and consumed none of the period.
    pub fn assert_untouched(&self, spent_in_period: i128) {
        assert_eq!(
            self.balance(&self.account),
            STARTING_BALANCE - spent_in_period
        );
        assert_eq!(self.mandate().spent_in_period, spent_in_period);
    }
}

/// Collapses a `try_` client result: `Ok` with the value, or `Err` with the error the
/// network returned, as text.
pub fn flatten<T, C, E>(result: Result<Result<T, C>, Result<E, InvokeError>>) -> Rejected<T>
where
    C: core::fmt::Debug,
    E: core::fmt::Debug,
{
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(conversion)) => panic!("unexpected return value: {conversion:?}"),
        Err(Ok(error)) => Err(std::format!("{error:?}")),
        Err(Err(invoke_error)) => Err(std::format!("{invoke_error:?}")),
    }
}

/// Asserts that the call was refused, and for which reason.
///
/// When `__check_auth` refuses, the caller sees one generic authorization error whatever
/// the reason. The reason (the contract error code) is in the host's diagnostic events,
/// which is also where a client reads it after simulating the transaction.
pub fn assert_rejected<T: core::fmt::Debug>(w: &World, result: Rejected<T>, code: u32) {
    let error = result.expect_err("expected a rejection");
    let diagnostics = std::format!("{:?}", w.e.host().get_diagnostic_events());
    assert!(
        error.contains(&std::format!("Error(Contract, #{code})"))
            || diagnostics.contains(&std::format!("Error(Contract({code}))")),
        "rejected with {error}, but contract error {code} is not in the diagnostics"
    );
}
