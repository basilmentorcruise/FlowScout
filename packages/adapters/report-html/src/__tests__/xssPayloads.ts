/**
 * T7-xss-payload-suite — shared adversarial payload fixtures (threat model M87.2 / e4-plan.md).
 *
 * Canonical payload classes: script tag · attribute breakout · event-handler injection ·
 * javascript: URL · data:text/html URL · title/context breakout · CSS breakout ·
 * pre-encoded entities (no double-encoding) · unicode-escaped script · nested tag ·
 * template-literal literal · null byte.
 *
 * Every untrusted field (appPurpose, workflow.name/description, featureGroup,
 * step.description, StateNode.label, actionType/actionPayload, screenshotUri) is driven
 * with each payload; the parsed output DOM must contain zero injected scripts/handlers.
 */

export interface XssPayload {
  readonly id: string;
  readonly value: string;
}

export const XSS_PAYLOADS: readonly XssPayload[] = [
  { id: "script-tag", value: "<script>alert(1)</script>" },
  { id: "attribute-breakout", value: '"><img src=x onerror=alert(1)>' },
  { id: "event-handler", value: '" onmouseover="alert(1)' },
  { id: "single-quote-event-handler", value: "'\"; onmouseover=alert(1)" },
  { id: "javascript-url", value: "javascript:alert(1)" },
  { id: "data-text-html-url", value: "data:text/html,<script>alert(1)</script>" },
  { id: "title-breakout", value: "</title><script>alert(1)</script>" },
  { id: "css-breakout", value: "</style><script>alert(1)</script>" },
  { id: "pre-encoded-entity", value: "&lt;script&gt;alert(1)&lt;/script&gt;" },
  { id: "double-url-encoded", value: "%253Cscript%253Ealert(1)%253C/script%253E" },
  { id: "nested-script-tag", value: "<scr<script>ipt>alert(1)</scr</script>ipt>" },
  { id: "svg-onload", value: '"><svg onload=alert(1)>' },
  { id: "unicode-escaped", value: "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e" },
  { id: "template-literal", value: "`${alert(1)}`" },
  { id: "null-byte", value: "before\u0000<script>alert(1)</script>after" },
];

/** Hostile screenshotUri values for the T2/M87.3 scheme-allowlist matrix. */
export const HOSTILE_IMAGE_URIS: readonly XssPayload[] = [
  { id: "javascript-scheme", value: "javascript:alert(1)" },
  { id: "data-text-html", value: "data:text/html,<script>alert(1)</script>" },
  { id: "data-svg", value: "data:image/svg+xml,<svg onload=alert(1)/>" },
  { id: "http-remote", value: "http://evil.example/x.png" },
  { id: "https-remote", value: "https://evil.example/x.png" },
  { id: "protocol-relative", value: "//evil.example/x.png" },
  { id: "blob-scheme", value: "blob:https://evil.example/uuid" },
  { id: "path-traversal", value: "../../../../etc/passwd" },
  { id: "traversal-png", value: "../../secret.png" },
  { id: "attribute-breakout-src", value: '"><script>alert(1)</script>.png' },
];
