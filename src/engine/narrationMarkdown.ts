/**
 * Render a stop's narration (markdown) as HTML for the sidebar. Narration can
 * come from a PR comment, so this is deliberately small: the text is escaped
 * first, and only a fixed set of tags is produced (paragraphs, headings as
 * bold lines, bullet and numbered lists, fenced code, inline code, bold and
 * italics). Links, images and raw HTML stay as plain text.
 */
export function renderNarrationMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break;
        code.push(lines[i]);
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<p class="md-heading">${inline(heading[1])}</p>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // An indented line continues the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join("");
}

/** Inline code first (its content stays literal), then bold and italics. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, index) => {
      if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
        .replace(/__(?=\S)([^_]*?\S)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
