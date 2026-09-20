/**
 * Wallet address validation for the wizard. One rule above all others (CLAUDE.md guardrail 1,
 * zero custody): only the PUBLIC address ever reaches us. A secret key pasted here is refused
 * loudly, with advice, and is never echoed back in the error.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { AgentPOSError } from "@agentpos/core";

/**
 * Returns the trimmed address when it is a valid Stellar public key (`G...`) or contract
 * address (`C...`, what `siteConfigSchema` accepts for `payTo`). Throws a typed error otherwise:
 *
 *  - `SECRET_IN_CONFIG` for anything that starts with `S`: that is the shape of a secret seed,
 *    and it must never leave the merchant's wallet.
 *  - `CONFIG_INVALID` for everything else.
 */
export function validateWalletAddress(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AgentPOSError("CONFIG_INVALID", "A Stellar address is required", {
      hint: "Paste the public address from your wallet app. It starts with G and has 56 characters.",
    });
  }
  const address = raw.trim();
  // A Stellar address is 56 characters. Refuse anything long before it reaches StrKey, and
  // never put the value itself in the error: this function also sees pasted secrets.
  if (address.length > 120) {
    throw new AgentPOSError("CONFIG_INVALID", "That is too long to be a Stellar address", {
      hint: "A public address has 56 characters and starts with G. Copy it again from your wallet app.",
      details: { length: address.length },
    });
  }
  if (address.startsWith("S")) {
    // Deliberately not included in details: an error object must never carry the secret.
    throw new AgentPOSError(
      "SECRET_IN_CONFIG",
      "That looks like a SECRET key, not a public address. It was not saved anywhere; do not paste it again.",
      {
        hint: "Paste only your PUBLIC address, which starts with G. If anyone else saw this secret, move your funds to a new wallet now.",
      },
    );
  }
  if (StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)) {
    return address;
  }
  throw new AgentPOSError("CONFIG_INVALID", "Not a valid Stellar address", {
    hint: "A public address has 56 characters and starts with G (or C for a contract). Copy it again from your wallet app.",
    details: { length: address.length },
  });
}
