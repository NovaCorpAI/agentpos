/** Machine-readable codes for every error this package throws. */
export type MeasureErrorCode =
  | "MEASURE_INVALID_EVENT"
  | "MEASURE_INVALID_PRICE_TABLE"
  | "MEASURE_PRICE_FILE_UNREADABLE";

/**
 * Typed error, `{ code, message, hint }`, so an agent can reason about it without parsing prose.
 */
export class MeasureError extends Error {
  override readonly name = "MeasureError";
  constructor(
    readonly code: MeasureErrorCode,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }

  toJSON(): { code: MeasureErrorCode; message: string; hint: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}
