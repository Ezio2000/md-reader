import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const serverPlugin = require("./server.js");
const clientPlugin = await import(pathToFileURL(path.join(process.cwd(), "plugins/mermaid/client.mjs")).href);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeDocument {
  constructor() {
    this.nodesById = new Map();
    this.head = {
      append: (node) => {
        this.nodesById.set(node.id, node);
      },
    };
  }

  getElementById(id) {
    return this.nodesById.get(id) || null;
  }

  createElement(tagName) {
    return {
      tagName,
      id: "",
      textContent: "",
    };
  }
}

function createFakeBlock(source) {
  const renderTarget = {
    innerHTML: "",
  };
  const errorTarget = {
    hidden: true,
    textContent: "",
  };
  const fallback = {
    hidden: false,
  };

  return {
    dataset: {
      mermaidSource: Buffer.from(source, "utf8").toString("base64"),
      mermaidState: "idle",
    },
    ownerDocument: new FakeDocument(),
    querySelector(selector) {
      if (selector === ".md-mermaid-render") {
        return renderTarget;
      }

      if (selector === ".md-mermaid-error") {
        return errorTarget;
      }

      if (selector === ".md-mermaid-fallback") {
        return fallback;
      }

      return null;
    },
    get renderTarget() {
      return renderTarget;
    },
    get errorTarget() {
      return errorTarget;
    },
    get fallback() {
      return fallback;
    },
  };
}

async function testServerPlugin() {
  let transformer;
  serverPlugin.activate({
    registerMarkdownTransformer(name, handler) {
      if (name === "mermaid-blocks") {
        transformer = handler;
      }
    },
  });

  assert(typeof transformer === "function", "Expected mermaid plugin to register a markdown transformer.");

  const result = await transformer({
    html: '<h1>Demo</h1><pre><code class="language-mermaid">graph TD;A--&gt;B</code></pre>',
    meta: {},
  });

  assert(result.meta.mermaid.blocks === 1, "Expected transformer metadata to include the mermaid block count.");
  assert(result.html.includes('class="md-mermaid-block"'), "Expected transformer to wrap mermaid blocks.");
  assert(result.html.includes("data-mermaid-source="), "Expected wrapped HTML to include encoded source.");
}

async function testClientPlugin() {
  const fakeBlock = createFakeBlock("graph TD;A-->B");
  const previewElement = {
    ownerDocument: fakeBlock.ownerDocument,
    querySelectorAll(selector) {
      if (selector === ".md-mermaid-block[data-mermaid-source]") {
        return [fakeBlock];
      }

      return [];
    },
  };

  let initializeCalls = 0;
  let registeredPreviewHandler;
  const fakeMermaidLoader = async () => ({
    initialize() {
      initializeCalls += 1;
    },
    async render(id, source) {
      return {
        svg: `<svg data-id="${id}"><text>${source}</text></svg>`,
      };
    },
  });

  const activate = clientPlugin.createActivate(fakeMermaidLoader);
  await activate({
    onPreviewRendered(handler) {
      registeredPreviewHandler = handler;
    },
  });

  assert(typeof registeredPreviewHandler === "function", "Expected client plugin to register a preview hook.");

  const renderSummary = await registeredPreviewHandler({
    previewElement,
    pluginMeta: {
      mermaid: {
        blocks: 1,
      },
    },
  });

  assert(initializeCalls === 1, "Expected Mermaid runtime to initialize exactly once.");
  assert(fakeBlock.dataset.mermaidState === "rendered", "Expected block state to be updated after rendering.");
  assert(fakeBlock.renderTarget.innerHTML.includes("<svg"), "Expected block to render SVG output.");
  assert(fakeBlock.fallback.hidden === true, "Expected mermaid fallback to be hidden after rendering.");
  assert(previewElement.ownerDocument.getElementById("md-reader-mermaid-plugin-style"), "Expected plugin styles to be injected.");

  const directRenderSummary = await clientPlugin.renderMermaidBlocks({
    previewElement,
    loadMermaid: fakeMermaidLoader,
  });
  assert(directRenderSummary.count === 1 && directRenderSummary.rendered === 1, "Expected direct render helper to return successful counts.");
  assert(renderSummary === undefined, "Preview hook should not need to return a value.");
}

await testServerPlugin();
await testClientPlugin();
console.log("Mermaid plugin tests passed.");
