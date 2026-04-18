const MERMAID_BLOCK_REGEX = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function buildMermaidWrapper(encodedSource, fallbackCodeHtml) {
  return [
    '<div class="md-mermaid-block" data-mermaid-state="idle" data-mermaid-source="',
    encodedSource,
    '">',
    '<div class="md-mermaid-render" aria-live="polite"></div>',
    '<div class="md-mermaid-error" hidden></div>',
    '<pre class="md-mermaid-fallback"><code class="language-mermaid">',
    fallbackCodeHtml,
    "</code></pre>",
    "</div>",
  ].join("");
}

function wrapMermaidBlocks(html) {
  let blockCount = 0;

  const wrappedHtml = html.replace(MERMAID_BLOCK_REGEX, (_match, encodedCodeHtml) => {
    const source = decodeHtmlEntities(encodedCodeHtml);
    const encodedSource = Buffer.from(source, "utf8").toString("base64");
    blockCount += 1;

    return buildMermaidWrapper(encodedSource, encodedCodeHtml);
  });

  return {
    html: wrappedHtml,
    count: blockCount,
  };
}

async function transformMarkdownPreview({ html, meta = {} }) {
  const result = wrapMermaidBlocks(html);
  if (!result.count) {
    return {
      html,
      meta,
    };
  }

  return {
    html: result.html,
    meta: {
      ...meta,
      mermaid: {
        blocks: result.count,
      },
    },
  };
}

function activate(api) {
  api.registerMarkdownTransformer("mermaid-blocks", transformMarkdownPreview);
}

module.exports = {
  activate,
  decodeHtmlEntities,
  wrapMermaidBlocks,
  transformMarkdownPreview,
};
