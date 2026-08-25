import { AgentGateError } from "@agentgate/core";

/** Connector errors reuse core codes; `retryable` drives the site library's retry loop. */
export function connectorHttpError(
  platform: string,
  status: number,
  body: unknown,
  hint?: string,
): AgentGateError {
  const retryable = status === 429 || status >= 500 || status === 0;
  return new AgentGateError(
    status === 401 || status === 403 ? "CONFIG_INVALID" : "INTERNAL",
    `${platform} API request failed (${status || "network"})`,
    {
      hint:
        hint ??
        (status === 401 || status === 403
          ? "Check the connector credentials and their permissions (read/write)."
          : "Inspect details.body; 429/5xx are retried automatically."),
      retryable,
      details: { status, body },
    },
  );
}
