/**
 * Wallet address validation for the wizard. One rule above all others (CONTRIBUTING.md, zero custody,
 * zero custody): only the PUBLIC address ever reaches us. A secret key pasted here is refused
 * loudly, with advice, and is never echoed back in the error.
 *
 * The messages are merchant-facing, so they are written in Spanish like the rest of the
 * installer; the codes (`SECRET_IN_CONFIG`, `CONFIG_INVALID`) are what a machine reads.
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
    throw new AgentPOSError("CONFIG_INVALID", "Falta la dirección de tu wallet", {
      hint: "Pega la dirección pública que muestra tu wallet. Empieza con G y tiene 56 caracteres.",
    });
  }
  const address = raw.trim();
  // A Stellar address is 56 characters. Refuse anything long before it reaches StrKey, and
  // never put the value itself in the error: this function also sees pasted secrets.
  if (address.length > 120) {
    throw new AgentPOSError("CONFIG_INVALID", "Eso es demasiado largo para ser una dirección", {
      hint: "Una dirección pública tiene 56 caracteres y empieza con G. Cópiala otra vez desde tu wallet.",
      details: { length: address.length },
    });
  }
  if (address.startsWith("S")) {
    // Deliberately not included in details: an error object must never carry the secret.
    throw new AgentPOSError(
      "SECRET_IN_CONFIG",
      "Eso parece una llave SECRETA, no una dirección pública. No se guardó en ninguna parte; no la vuelvas a pegar.",
      {
        hint: "Pega solo tu dirección PÚBLICA, la que empieza con G. Si alguien más pudo ver esa llave secreta, mueve tus fondos a una wallet nueva ahora.",
      },
    );
  }
  if (StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)) {
    return address;
  }
  throw new AgentPOSError("CONFIG_INVALID", "Esa no es una dirección válida de Stellar", {
    hint: "Una dirección pública tiene 56 caracteres y empieza con G (o con C si es un contrato). Cópiala otra vez desde tu wallet.",
    details: { length: address.length },
  });
}
