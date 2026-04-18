const ECHARTS_BLOCK_REGEX = /<pre><code class="language-echarts">([\s\S]*?)<\/code><\/pre>|<pre><code class="language-echart">([\s\S]*?)<\/code><\/pre>/g;

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function buildEChartsWrapper(encodedSource, fallbackCodeHtml) {
  return [
    '<div class="md-echarts-block" data-echarts-state="idle" data-echarts-source="',
    encodedSource,
    '">',
    '<div class="md-echarts-render" aria-live="polite"></div>',
    '<div class="md-echarts-error" hidden></div>',
    '<pre class="md-echarts-fallback"><code class="language-echarts">',
    fallbackCodeHtml,
    "</code></pre>",
    "</div>",
  ].join("");
}

function wrapEChartsBlocks(html) {
  let blockCount = 0;

  const wrappedHtml = html.replace(ECHARTS_BLOCK_REGEX, (_match, echartsCodeHtml, echartCodeHtml) => {
    const encodedCodeHtml = echartsCodeHtml ?? echartCodeHtml ?? "";
    const source = decodeHtmlEntities(encodedCodeHtml);
    const encodedSource = Buffer.from(source, "utf8").toString("base64");
    blockCount += 1;

    return buildEChartsWrapper(encodedSource, encodedCodeHtml);
  });

  return {
    html: wrappedHtml,
    count: blockCount,
  };
}

async function transformMarkdownPreview({ html, meta = {} }) {
  const result = wrapEChartsBlocks(html);
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
      echarts: {
        blocks: result.count,
      },
    },
  };
}

function activate(api) {
  api.registerMarkdownTransformer("echarts-blocks", transformMarkdownPreview);
}

module.exports = {
  activate,
  decodeHtmlEntities,
  wrapEChartsBlocks,
  transformMarkdownPreview,
};
