// SPDX-License-Identifier: Apache-2.0
// Derived from DeltaX Decision Relay. The objective is adapted for Receiving Desk.
// See NOTICE for the original attribution and exact source revision.

const PINNED_TOKEN_URL = "https://access-api.deltaxevaluate.com/api/builder/oauth/token";
const PINNED_EVAL_URL = "https://access-api.deltaxevaluate.com/api/builder/evaluations";
const API_VERSION = "2026-09-16.beta2";
const PROFILE_ID = "deltax-hosted-bounded-review-evaluation-v1";
const OBJECTIVE = "Select a supported receipt disposition for a fictional carton delivery.";
const REQUIRED_SCOPE = "deltax:evaluate";

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_EVAL_BYTES = 64 * 1024;
const MAX_TOKEN_EXPIRES_S = 900;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_CONTEXT_KEYS = 16;
const MAX_CONTEXT_KEY_LEN = 64;
const MAX_CONTEXT_STR_LEN = 256;
const MIN_CANDIDATES = 1;
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_ID_LEN = 64;
const MAX_DESCRIPTION_LEN = 512;
const MAX_IDEMPOTENCY_KEY_LEN = 128;

const VALID_SEMANTIC_CLASSES = new Set(["analyze", "compare", "validate"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const EXPECTED_GATES = Array.from({ length: 12 }, (_, i) => `HES-G${String(i + 1).padStart(2, "0")}`);

const TRACE_FALSE_FLAGS = [
  "submitted_candidate_executed",
  "external_effect",
  "learning_applied",
  "operator_reported_context_verified"
];

const AUTHORITY_FALSE_FLAGS = [
  "selected_is_executed",
  "selected_is_correct_or_safe",
  "response_authorizes_downstream_action",
  "response_is_professional_advice",
  "trace_is_certification_or_legal_non_repudiation"
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidIsoTimestamp(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isValidDigest(value) {
  return typeof value === "string" && SHA256_RE.test(value);
}

function clampTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs)), MAX_TIMEOUT_MS);
}

function getHeader(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return null;
}

function validateContext(context) {
  if (!isPlainObject(context)) {
    return null;
  }
  const keys = Object.keys(context);
  if (keys.length > MAX_CONTEXT_KEYS) {
    return null;
  }
  const sanitized = {};
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key) || key.length === 0 || key.length > MAX_CONTEXT_KEY_LEN || /[\r\n\0]/.test(key)) {
      return null;
    }
    const val = context[key];
    if (typeof val === "string") {
      if (val.length > MAX_CONTEXT_STR_LEN || /[\0]/.test(val)) {
        return null;
      }
      sanitized[key] = val;
    } else if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        return null;
      }
      sanitized[key] = val;
    } else if (typeof val === "boolean" || val === null) {
      sanitized[key] = val;
    } else {
      return null;
    }
  }
  return sanitized;
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) {
    return null;
  }
  const seenIds = new Set();
  const sanitized = [];
  const allowedFields = new Set(["candidate_id", "semantic_class", "description", "operator_reported_support"]);

  for (const item of candidates) {
    if (!isPlainObject(item)) {
      return null;
    }
    for (const key of Object.keys(item)) {
      if (!allowedFields.has(key)) {
        return null;
      }
    }
    const { candidate_id, semantic_class, description, operator_reported_support } = item;
    if (
      typeof candidate_id !== "string" ||
      candidate_id.length === 0 ||
      candidate_id.length > MAX_CANDIDATE_ID_LEN ||
      /[\s\0]/.test(candidate_id) ||
      seenIds.has(candidate_id)
    ) {
      return null;
    }
    if (!VALID_SEMANTIC_CLASSES.has(semantic_class)) {
      return null;
    }
    if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_DESCRIPTION_LEN) {
      return null;
    }
    if (
      typeof operator_reported_support !== "number" ||
      !Number.isFinite(operator_reported_support) ||
      operator_reported_support < 0 ||
      operator_reported_support > 1
    ) {
      return null;
    }
    seenIds.add(candidate_id);
    sanitized.push({
      candidate_id,
      semantic_class,
      description,
      operator_reported_support
    });
  }

  return { sanitized, candidateIds: seenIds };
}

function validateIdempotencyKey(idempotencyKey) {
  return (
    typeof idempotencyKey === "string" &&
    idempotencyKey.length > 0 &&
    idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_LEN &&
    !/[\r\n\0\s]/.test(idempotencyKey)
  );
}

async function readCappedJson(response, maxBytes, signal) {
  const contentLengthRaw = getHeader(response.headers, "content-length");
  if (contentLengthRaw !== null) {
    const declared = Number(contentLengthRaw);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, code: "RESPONSE_TOO_LARGE" };
    }
  }

  let rawBytes;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      rejectAbort(new DOMException("Aborted", "AbortError"));
      void reader.cancel().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        return { ok: false, code: "TIMEOUT" };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      while (true) {
        const step = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
        if (signal?.aborted) {
          return { ok: false, code: "TIMEOUT" };
        }
        if (step.done) {
          break;
        }
        const chunk = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, code: "RESPONSE_TOO_LARGE" };
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        return { ok: false, code: "TIMEOUT" };
      }
      return { ok: false, code: "NETWORK_ERROR" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    rawBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else if (typeof response.arrayBuffer === "function") {
    const buf = await response.arrayBuffer();
    if (signal?.aborted) {
      return { ok: false, code: "TIMEOUT" };
    }
    if (buf.byteLength > maxBytes) {
      return { ok: false, code: "RESPONSE_TOO_LARGE" };
    }
    rawBytes = new Uint8Array(buf);
  } else if (typeof response.text === "function") {
    const txt = await response.text();
    if (signal?.aborted) {
      return { ok: false, code: "TIMEOUT" };
    }
    rawBytes = new TextEncoder().encode(txt);
    if (rawBytes.byteLength > maxBytes) {
      return { ok: false, code: "RESPONSE_TOO_LARGE" };
    }
  } else {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const parsed = JSON.parse(decoded);
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
}

function validateTokenPayload(data) {
  if (!isPlainObject(data)) {
    return null;
  }
  if (typeof data.token_type !== "string" || data.token_type !== "Bearer") {
    return null;
  }
  if (
    typeof data.access_token !== "string" ||
    !data.access_token.startsWith("dxbt_") ||
    data.access_token.length <= 5 ||
    /[\r\n\s\0]/.test(data.access_token)
  ) {
    return null;
  }
  if (typeof data.scope !== "string" || !data.scope.split(/\s+/).includes(REQUIRED_SCOPE)) {
    return null;
  }
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    return null;
  }
  const cappedSeconds = Math.min(data.expires_in, MAX_TOKEN_EXPIRES_S);
  const safetyMarginMs = cappedSeconds > 30 ? 30_000 : Math.floor(cappedSeconds * 1000 * 0.2);
  return {
    token: data.access_token,
    ttlMs: Math.max(0, cappedSeconds * 1000 - safetyMarginMs)
  };
}

function validateAndNormalizeEvalPayload(data, submittedCandidateIds) {
  if (!isPlainObject(data)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (typeof data.receipt_id !== "string" || !data.receipt_id.startsWith("eval_") || data.receipt_id.length <= 5) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (!isValidIsoTimestamp(data.evaluated_at)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (typeof data.counted !== "boolean") {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  const result = data.result;
  if (!isPlainObject(result)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (result.api_version !== undefined && result.api_version !== API_VERSION) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (data.api_version !== undefined && data.api_version !== API_VERSION) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (result.profile_id !== undefined && result.profile_id !== PROFILE_ID) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (data.profile_id !== undefined && data.profile_id !== PROFILE_ID) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  if (result.outcome !== "selected" && result.outcome !== "governed_noop_refusal") {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (result.outcome === "selected") {
    if (typeof result.selected_candidate_id !== "string" || !submittedCandidateIds.has(result.selected_candidate_id)) {
      return { ok: false, code: "FOREIGN_CANDIDATE" };
    }
  } else if (result.selected_candidate_id !== null) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  if (
    !Array.isArray(result.reason_codes) ||
    !result.reason_codes.every((code) => typeof code === "string" && code.length > 0)
  ) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  const trace = result.trace;
  if (!isPlainObject(trace)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (
    !isValidDigest(trace.request_digest) ||
    !isValidDigest(trace.candidate_field_digest) ||
    !isValidDigest(trace.policy_digest) ||
    !isValidDigest(trace.release_set_digest)
  ) {
    return { ok: false, code: "INVALID_DIGEST" };
  }
  if (typeof trace.trace_id !== "string" || trace.trace_id.length === 0 || !isValidIsoTimestamp(trace.committed_at)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (!Array.isArray(trace.evidence_labels) || !trace.evidence_labels.every((l) => typeof l === "string")) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  for (const flag of TRACE_FALSE_FLAGS) {
    if (trace[flag] !== false) {
      return { ok: false, code: "INVALID_AUTHORITY" };
    }
  }

  if (!Array.isArray(trace.lambda_decisions) || trace.lambda_decisions.length !== EXPECTED_GATES.length) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  const normalizedGates = [];
  for (let i = 0; i < EXPECTED_GATES.length; i += 1) {
    const entry = trace.lambda_decisions[i];
    if (!isPlainObject(entry)) {
      return { ok: false, code: "MALFORMED_RESPONSE" };
    }
    const gateId = entry.gate_id;
    const verdict = entry.disposition;
    if (gateId !== EXPECTED_GATES[i]) {
      return { ok: false, code: "MALFORMED_RESPONSE" };
    }
    if (verdict !== "pass" && verdict !== "fail") {
      return { ok: false, code: "MALFORMED_RESPONSE" };
    }
    if (typeof entry.reason_code !== "string" || entry.reason_code.length === 0) {
      return { ok: false, code: "MALFORMED_RESPONSE" };
    }
    normalizedGates.push({
      gateId,
      decision: verdict,
      reasonCode: entry.reason_code
    });
  }

  const commercialReceipt = result.commercial_receipt;
  if (!isPlainObject(commercialReceipt)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (commercialReceipt.mode !== "free_beta") {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }
  if (!isValidDigest(commercialReceipt.receipt_sha256) || !isValidDigest(commercialReceipt.commercial_binding_sha256)) {
    return { ok: false, code: "INVALID_DIGEST" };
  }
  if (typeof commercialReceipt.receipt_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commercialReceipt.receipt_id) ||
      !isValidIsoTimestamp(commercialReceipt.committed_at) ||
      Date.parse(commercialReceipt.committed_at) !== Date.parse(trace.committed_at)) {
    return { ok: false, code: "MALFORMED_RESPONSE" };
  }

  const authority = result.authority;
  if (!isPlainObject(authority)) {
    return { ok: false, code: "INVALID_AUTHORITY" };
  }
  for (const flag of AUTHORITY_FALSE_FLAGS) {
    if (authority[flag] !== false) {
      return { ok: false, code: "INVALID_AUTHORITY" };
    }
  }

  return {
    ok: true,
    value: {
      status: result.outcome === "selected" ? "selected" : "refused",
      code: result.outcome === "selected" ? "SELECTED" : "GOVERNED_NOOP_REFUSAL",
      counted: data.counted,
      receiptId: data.receipt_id,
      providerReceiptId: commercialReceipt.receipt_id,
      selectedCandidateId: result.selected_candidate_id,
      reasonCodes: [...result.reason_codes],
      evidence: {
        requestDigest: trace.request_digest,
        policyDigest: trace.policy_digest,
        receiptDigest: commercialReceipt.receipt_sha256,
        gates: normalizedGates,
        evaluatedAt: data.evaluated_at
      }
    }
  };
}

function mapFetchFailure(err, signal) {
  if (signal?.aborted || err?.name === "AbortError") {
    return { status: "unknown", code: "TIMEOUT" };
  }
  const msg = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  if (msg.includes("redirect")) {
    return { status: "rejected", code: "REDIRECT_REJECTED" };
  }
  return { status: "unknown", code: "NETWORK_ERROR" };
}

/**
 * Creates a hosted evaluation client pinned to the DeltaX evaluation gateway.
 */
export function createHostedEvaluate({
  clientId,
  clientSecret,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now
} = {}) {
  const effectiveTimeoutMs = clampTimeout(timeoutMs);
  const isConfigured =
    typeof clientId === "string" &&
    clientId.trim().length > 0 &&
    typeof clientSecret === "string" &&
    clientSecret.trim().length > 0;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  let cachedToken = null;

  async function acquireToken(signal) {
    const currentMs = now();
    if (cachedToken !== null && currentMs < cachedToken.expiresAtMs) {
      return { ok: true, token: cachedToken.token };
    }
    cachedToken = null;

    const formBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: REQUIRED_SCOPE
    }).toString();

    let response;
    try {
      response = await fetchImpl(PINNED_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json"
        },
        body: formBody,
        redirect: "error",
        signal
      });
    } catch (err) {
      return { ok: false, result: mapFetchFailure(err, signal) };
    }

    if (response.redirected === true || (response.status >= 300 && response.status < 400)) {
      return { ok: false, result: { status: "rejected", code: "REDIRECT_REJECTED" } };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, result: { status: "rejected", code: "UNAUTHORIZED" } };
    }
    if (response.status === 429) {
      return { ok: false, result: { status: "rejected", code: "QUOTA_EXCEEDED" } };
    }
    if (response.status >= 500) {
      return { ok: false, result: { status: "unknown", code: "UPSTREAM_5XX" } };
    }
    if (response.status !== 200) {
      return { ok: false, result: { status: "rejected", code: "TOKEN_REJECTED" } };
    }

    const parsed = await readCappedJson(response, MAX_TOKEN_BYTES, signal);
    if (!parsed.ok) {
      return { ok: false, result: { status: "unknown", code: parsed.code } };
    }

    const validated = validateTokenPayload(parsed.data);
    if (!validated) {
      return { ok: false, result: { status: "unknown", code: "TOKEN_MALFORMED" } };
    }

    cachedToken = {
      token: validated.token,
      expiresAtMs: now() + validated.ttlMs
    };
    return { ok: true, token: validated.token };
  }

  return async function evaluate({ context, candidates, idempotencyKey } = {}) {
    if (!isConfigured) {
      return { status: "unconfigured", code: "UNCONFIGURED" };
    }

    const sanitizedContext = validateContext(context);
    const validatedCandidates = validateCandidates(candidates);
    if (!sanitizedContext || !validatedCandidates || !validateIdempotencyKey(idempotencyKey)) {
      return { status: "rejected", code: "INVALID_INPUT" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const tokenResult = await acquireToken(controller.signal);
      if (!tokenResult.ok) {
        return tokenResult.result;
      }

      const evalBody = JSON.stringify({
        profile_id: PROFILE_ID,
        objective: OBJECTIVE,
        context: sanitizedContext,
        candidates: validatedCandidates.sanitized
      });

      let response;
      try {
        response = await fetchImpl(PINNED_EVAL_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${tokenResult.token}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-DeltaX-API-Version": API_VERSION
          },
          body: evalBody,
          redirect: "error",
          signal: controller.signal
        });
      } catch (err) {
        return mapFetchFailure(err, controller.signal);
      }

      if (response.redirected === true || (response.status >= 300 && response.status < 400)) {
        return { status: "rejected", code: "REDIRECT_REJECTED" };
      }
      if (response.status === 202) {
        return { status: "unknown", code: "PENDING_202" };
      }
      if (response.status === 401 || response.status === 403) {
        cachedToken = null;
        return { status: "rejected", code: "UNAUTHORIZED" };
      }
      if (response.status === 429) {
        return { status: "rejected", code: "QUOTA_EXCEEDED" };
      }
      if (response.status >= 500) {
        return { status: "unknown", code: "UPSTREAM_5XX" };
      }
      if (response.status !== 200) {
        return { status: "rejected", code: "REQUEST_REJECTED" };
      }

      const parsed = await readCappedJson(response, MAX_EVAL_BYTES, controller.signal);
      if (!parsed.ok) {
        return { status: "unknown", code: parsed.code };
      }

      const validated = validateAndNormalizeEvalPayload(parsed.data, validatedCandidates.candidateIds);
      if (!validated.ok) {
        return { status: "unknown", code: validated.code };
      }
      return validated.value;
    } finally {
      clearTimeout(timer);
    }
  };
}
