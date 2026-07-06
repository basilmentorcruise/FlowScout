/**
 * Safe-HTML engine unit tests (ADR-0009 §1, threat model M87.1/M87.2).
 * The `html` tagged template is the single auditable encoding boundary:
 * every non-SafeHtml interpolation is HTML-entity encoded; only SafeHtml
 * (produced by `html` itself or package-internal `trustedRaw`) passes through.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { html, trustedRaw, isSafeHtml } from "../html.js";
import { XSS_PAYLOADS } from "./xssPayloads.js";

function parseFragment(markup: string): Document {
  const window = new Window();
  window.document.body.innerHTML = markup;
  return window.document as unknown as Document;
}

describe("html tagged template — escaping table", () => {
  it("escapes & < > \" ' in element-text position", () => {
    const out = html`<p>${`Tom & Jerry <b> "quoted" 'single'`}</p>`;
    expect(out.value).toBe("<p>Tom &amp; Jerry &lt;b&gt; &quot;quoted&quot; &#39;single&#39;</p>");
  });

  it("escapes quotes in attribute position so breakout is impossible", () => {
    const out = html`<p title="${'" onmouseover="alert(1)'}">x</p>`;
    expect(out.value).toBe('<p title="&quot; onmouseover=&quot;alert(1)">x</p>');
  });

  it("encodes exactly once — pre-encoded entities render literally (no double-encode skip)", () => {
    const out = html`<p>${"&lt;script&gt;"}</p>`;
    expect(out.value).toBe("<p>&amp;lt;script&amp;gt;</p>");
  });

  it("renders numbers", () => {
    expect(html`<i>${42}</i>`.value).toBe("<i>42</i>");
  });

  it("renders null and undefined as empty string", () => {
    expect(html`<i>${null}</i>`.value).toBe("<i></i>");
    expect(html`<i>${undefined}</i>`.value).toBe("<i></i>");
  });

  it("replaces null bytes with U+FFFD instead of passing them through", () => {
    const out = html`<p>${"a\u0000b"}</p>`;
    expect(out.value).toBe("<p>a�b</p>");
  });
});

describe("html tagged template — SafeHtml composition", () => {
  it("passes nested SafeHtml through without double-encoding", () => {
    const inner = html`<em>${"a & b"}</em>`;
    const outer = html`<p>${inner}</p>`;
    expect(outer.value).toBe("<p><em>a &amp; b</em></p>");
  });

  it("joins arrays of SafeHtml without separators", () => {
    const items = ["a", "b"].map((v) => html`<li>${v}</li>`);
    // prettier-ignore
    const out = html`<ul>${items}</ul>`;
    expect(out.value).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("escapes each element of a raw-string array", () => {
    const out = html`<p>${["<x>", "&"]}</p>`;
    expect(out.value).toBe("<p>&lt;x&gt;&amp;</p>");
  });

  it("trustedRaw passes package-owned static fragments through verbatim", () => {
    // prettier-ignore
    const out = html`<head>${trustedRaw("<style>:root{}</style>")}</head>`;
    expect(out.value).toBe("<head><style>:root{}</style></head>");
  });

  it("isSafeHtml discriminates branded values from plain objects and strings", () => {
    expect(isSafeHtml(html`<p></p>`)).toBe(true);
    expect(isSafeHtml(trustedRaw(""))).toBe(true);
    expect(isSafeHtml("<p></p>")).toBe(false);
    expect(isSafeHtml({ value: "<p></p>" })).toBe(false);
    expect(isSafeHtml(null)).toBe(false);
  });
});

describe("T7-xss-payload-suite — engine level (M87.2)", () => {
  describe.each(XSS_PAYLOADS.map((p) => [p.id, p.value] as const))("payload %s", (_id, payload) => {
    it("is inert in element-text position (parsed DOM has no script/handler)", () => {
      const doc = parseFragment(html`<p>${payload}</p>`.value);
      expect(doc.querySelectorAll("script").length).toBe(0);
      expect(doc.querySelectorAll("img, svg, style, iframe").length).toBe(0);
      for (const el of Array.from(doc.body.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.startsWith("on")).toBe(false);
        }
      }
      // The payload survives as visible text (minus the stripped null byte).
      const expectedText = payload.replaceAll("\u0000", "�");
      expect(doc.querySelector("p")?.textContent).toBe(expectedText);
    });

    it("is inert in attribute position (no breakout, attribute stays quoted)", () => {
      const doc = parseFragment(html`<p title="${payload}" data-x="${payload}">x</p>`.value);
      expect(doc.querySelectorAll("script, img, svg").length).toBe(0);
      const p = doc.querySelector("p");
      expect(p).not.toBeNull();
      for (const attr of Array.from(p?.attributes ?? [])) {
        expect(["title", "data-x"]).toContain(attr.name);
      }
      expect(p?.getAttribute("title")).toBe(payload.replaceAll("\u0000", "�"));
    });
  });
});
