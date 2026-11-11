import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNarrationMarkdown } from "../out-test/ux/narrationMarkdown.js";

test("renders paragraphs, lists, bold, italics and inline code", () => {
  const html = renderNarrationMarkdown(
    "Before this PR the listener ran on *defaults*.\n\n`FleetLimits` holds every bound:\n- **Time:** TLS 10 s\n- **Counts:** 50,000\n\n1. First\n2. Second",
  );
  assert.equal(
    html,
    "<p>Before this PR the listener ran on <em>defaults</em>.</p>" +
      "<p><code>FleetLimits</code> holds every bound:</p>" +
      "<ul><li><strong>Time:</strong> TLS 10 s</li><li><strong>Counts:</strong> 50,000</li></ul>" +
      "<ol><li>First</li><li>Second</li></ol>",
  );
});

test("keeps HTML, links and images from a comment as plain text", () => {
  const html = renderNarrationMarkdown(
    '<img src=x onerror=alert(1)> [click](command:workbench.action.terminal.sendSequence) ![i](https://evil.example/x.png) <script>alert(1)</script>',
  );
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<a "), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /\[click\]\(command:workbench/);
});

test("leaves code literal and escapes it", () => {
  assert.equal(renderNarrationMarkdown("Use `**not bold** <b>`."), "<p>Use <code>**not bold** &lt;b&gt;</code>.</p>");
  assert.equal(
    renderNarrationMarkdown("```rust\nlet x = a < b && **c**;\n```"),
    "<pre><code>let x = a &lt; b &amp;&amp; **c**;</code></pre>",
  );
});

test("doesn't italicize identifiers with underscores or multiplication", () => {
  assert.equal(renderNarrationMarkdown("snake_case_name and 2 * 3 * 4"), "<p>snake_case_name and 2 * 3 * 4</p>");
});

test("joins single newlines inside a paragraph with line breaks", () => {
  assert.equal(renderNarrationMarkdown("one\ntwo"), "<p>one<br>two</p>");
  assert.equal(renderNarrationMarkdown("# Heading\ntext"), '<p class="md-heading">Heading</p><p>text</p>');
});
