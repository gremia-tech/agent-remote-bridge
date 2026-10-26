export class BridgeError extends Error {
  constructor(public code: string, message: string, public status = 400, public deliveryAmbiguous = false) { super(message); }
}
export function failure(error: unknown) {
  // Never serialize arbitrary backend exception text: it may contain a prompt, path, or token.
  if (error instanceof BridgeError || (error instanceof Error && "code" in error && "status" in error)) {
    const e = error as BridgeError;
    return { status: e.status, body: { error: { code: e.code, message: safeMessage(e.code) }, ...(e.deliveryAmbiguous ? { deliveryAmbiguous: true } : {}) } };
  }
  return { status: 503, body: { error: { code: "host_unavailable", message: "The host could not complete this request." } } };
}
function safeMessage(code: string) {
  const messages: Record<string,string> = {
    invalid_name:"Use a lowercase agent name, starting with a letter, with letters, digits, - or _, up to 32 characters.", agent_not_installed:"Install and configure this agent tool in the coding environment first.",
    invalid_request:"The request is invalid.", invalid_credentials:"Pair this device again.", invitation_expired:"This invitation has expired or was already used.",
    forbidden:"This device does not have permission.", origin_denied:"Browser origins are not permitted.", not_found:"The requested resource was not found.",
    identity_changed:"The pane has changed. Refresh before continuing.", control_conflict:"This pane already has a controller. Explicit takeover is required.",
    lease_expired:"Control expired. Acquire control again.", request_conflict:"This request ID was already used with different content.",
    request_too_large:"The request exceeds the size limit.", response_too_large:"The response exceeds the size limit.", rate_limited:"Too many requests. Try again later.",
    unsupported:"This host does not support this operation.", journal_full:"The operation journal is full. Pair a new device to continue.",
    host_unavailable:"The host is unavailable.", invalid_code:"That code does not match the one shown on the computer.", delivery_unknown:"Delivery is uncertain. Check operation status before taking further action.",
  };
  return messages[code] ?? "The host could not complete this request.";
}
