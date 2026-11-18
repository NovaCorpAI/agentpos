//! Stateless Ed25519 verifier.
//!
//! A mandate account stores each session key as `Signer::External(verifier, public_key)`.
//! This contract is that verifier: it holds no state and has no owner, so one deployment
//! serves every account. All cryptography is the host's `ed25519_verify`, reached through
//! OpenZeppelin's `stellar-accounts` helpers.
#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{ed25519, Verifier};

#[contract]
pub struct Ed25519Verifier;

#[contractimpl]
impl Verifier for Ed25519Verifier {
    type KeyData = BytesN<32>;
    type SigData = BytesN<64>;

    /// Returns `true` when `sig_data` is a valid signature of `hash` by `key_data`.
    /// Traps on an invalid signature, which fails the authorization.
    fn verify(e: &Env, hash: Bytes, key_data: BytesN<32>, sig_data: BytesN<64>) -> bool {
        ed25519::verify(e, &hash, &key_data, &sig_data)
    }

    fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, key_data: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519::batch_canonicalize_key(e, &key_data)
    }
}
