/**
 * Safe-HTML engine — the ONE auditable encoding boundary (ADR-0009 §1, threat model M87.1).
 *
 * Every untrusted-origin string reaches markup ONLY through this module:
 *   - `html` tagged template  → HTML-entity encodes every non-SafeHtml interpolation.
 *   - `safeAnchorId`          → charset-allowlisted derived token for id="…" / href="#…".
 *   - `safeImageSrc`          → scheme allowlist for <img src> (data:image/* base64, or a
 *                               plain relative / file: path in reference mode).
 *   - `trustedRaw`            → reserved for PACKAGE-INTERNAL STATIC fragments only
 *                               (the stylesheet / document skeleton). Never call it with a
 *                               value derived from input — greppable review point.
 *
 * There is no other way to produce `SafeHtml`, so an unescaped untrusted string reaching
 * the document is a compile-time type error, not a review catch.
 */

/** Nominal brand (same trick as domain's StateIdentity/ConfidenceScore). */
const SAFE_HTML_BRAND = "flowscout.report-html.SafeHtml";

/**
 * A fragment of markup that is safe to concatenate into the document verbatim.
 * The ONLY thing section functions may return and the document writer accepts.
 */
export interface SafeHtml {
  readonly __brand: typeof SAFE_HTML_BRAND;
  /** The already-encoded markup. */
  readonly value: string;
}

function wrap(value: string): SafeHtml {
  return Object.freeze({ __brand: SAFE_HTML_BRAND, value });
}

/** Runtime discriminator used by the tagged template for pass-through composition. */
export function isSafeHtml(candidate: unknown): candidate is SafeHtml {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { __brand?: unknown }).__brand === SAFE_HTML_BRAND &&
    typeof (candidate as { value?: unknown }).value === "string"
  );
}

/**
 * HTML-entity encode `& < > " '` (element-text AND quoted-attribute safe) and replace
 * NUL (an HTML parse error) with U+FFFD. Encoding is exactly-once by construction:
 * already-encoded input is encoded again so it renders literally (no decode-then-skip).
 */
function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\u0000", "�");
}

/** Values the `html` template accepts. Raw strings are ALWAYS escaped. */
export type HtmlInterpolation =
  | string
  | number
  | SafeHtml
  | null
  | undefined
  | readonly HtmlInterpolation[];

function encodeInterpolation(value: HtmlInterpolation): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (isSafeHtml(value)) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return (value as readonly HtmlInterpolation[]).map(encodeInterpolation).join("");
  }
  if (typeof value === "number") {
    return String(value);
  }
  return escapeHtml(value as string);
}

/**
 * Escaped-by-default tagged template. Static parts are package-owned literals;
 * every interpolation is entity-encoded unless it is already `SafeHtml`
 * (composition) or an array of interpolations (each encoded independently).
 */
export function html(strings: TemplateStringsArray, ...values: HtmlInterpolation[]): SafeHtml {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? "";
    if (i < values.length) {
      out += encodeInterpolation(values[i]);
    }
  }
  return wrap(out);
}

/**
 * Mark a PACKAGE-INTERNAL STATIC fragment (stylesheet, document skeleton) as safe.
 * MUST NOT be called with any value derived from renderer input — this name exists
 * to be grepped by the security gate.
 */
export function trustedRaw(staticFragment: string): SafeHtml {
  return wrap(staticFragment);
}

/** Deterministic 32-bit FNV-1a hash (hex) — collision guard for sanitized anchors. */
function fnv1a32Hex(input: string): string {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  const HEX_WIDTH = 8;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(HEX_WIDTH, "0");
}

/**
 * Anchor/id context encoder (T4): derives a deterministic token restricted to
 * `[A-Za-z0-9_-]` for `id="…"` / `href="#…"`. Characters outside the allowlist are
 * replaced with `-` and a stable hash suffix is appended so distinct hostile inputs
 * cannot collide after sanitization. Never returns an empty token.
 */
export function safeAnchorId(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "-");
  if (sanitized === raw && sanitized.length > 0) {
    return sanitized;
  }
  return `${sanitized}-${fnv1a32Hex(raw)}`;
}

/** Rendering mode for screenshot sources (mirrors RenderOptions.embedScreenshots). */
export type ImageSrcMode = "embed" | "reference";

const DATA_IMAGE_SRC = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
// Visible ASCII only (no whitespace/control chars) …
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// … and none of the characters that are markup- or shell-significant in a URL attribute.
const FORBIDDEN_PATH_CHARS = /["'\\<>`]/;
const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function isContainedPath(candidate: string): boolean {
  if (!VISIBLE_ASCII.test(candidate) || FORBIDDEN_PATH_CHARS.test(candidate)) {
    return false;
  }
  if (candidate.startsWith("//")) {
    return false;
  }
  const scheme = URI_SCHEME.exec(candidate);
  if (scheme && scheme[1]?.toLowerCase() !== "file") {
    return false;
  }
  const pathPart = scheme ? candidate.slice(scheme[0].length) : candidate;
  const segments = pathPart.split("/");
  return !segments.includes("..");
}

/**
 * URL context encoder for `<img src>` (T2/M87.3 scheme allowlist).
 *
 * - `embed` mode accepts ONLY `data:image/(png|jpeg|webp);base64,<base64>` — the URIs
 *   this package generates itself. The raw screenshotUri is never emitted.
 * - `reference` mode accepts ONLY a plain relative path or `file:` URI with no `..`
 *   segments, no other scheme, and attribute-hygienic characters. (Realpath containment
 *   in the screenshot store is enforced separately at load time — see screenshots.ts.)
 *
 * Anything else returns `null` → the caller renders the no-image placeholder.
 */
export function safeImageSrc(raw: string, mode: ImageSrcMode): string | null {
  if (raw.length === 0) {
    return null;
  }
  if (mode === "embed") {
    return DATA_IMAGE_SRC.test(raw) ? raw : null;
  }
  if (raw.toLowerCase().startsWith("data:")) {
    return null;
  }
  return isContainedPath(raw) ? raw : null;
}
