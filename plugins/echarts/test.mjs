import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const serverPlugin = require("./server.js");
const clientPlugin = await import(pathToFileURL(path.join(process.cwd(), "plugins/echarts/client.mjs")).href);

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
    style: {},
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
      echartsSource: Buffer.from(source, "utf8").toString("base64"),
      echartsState: "idle",
    },
    ownerDocument: new FakeDocument(),
    querySelector(selector) {
      if (selector === ".md-echarts-render") {
        return renderTarget;
      }

      if (selector === ".md-echarts-error") {
        return errorTarget;
      }

      if (selector === ".md-echarts-fallback") {
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
      if (name === "echarts-blocks") {
        transformer = handler;
      }
    },
  });

  assert(typeof transformer === "function", "Expected echarts plugin to register a markdown transformer.");

  const result = await transformer({
    html: '<h1>Demo</h1><pre><code class="language-echarts">{ "series": [] }</code></pre>',
    meta: {},
  });

  assert(result.meta.echarts.blocks === 1, "Expected transformer metadata to include the echarts block count.");
  assert(result.html.includes('class="md-echarts-block"'), "Expected transformer to wrap echarts blocks.");
  assert(result.html.includes("data-echarts-source="), "Expected wrapped HTML to include encoded source.");
}

async function testClientPlugin() {
  const fakeBlock = createFakeBlock('{ "title": { "text": "Demo" }, "series": [] }');
  const previewElement = {
    ownerDocument: fakeBlock.ownerDocument,
    querySelectorAll(selector) {
      if (selector === ".md-echarts-block[data-echarts-source]") {
        return [fakeBlock];
      }

      return [];
    },
  };

  let initCalls = 0;
  let setOptionCalls = 0;
  let disposeCalls = 0;
  let registeredPreviewHandler;
  let registeredClearHandler;
  let registeredWorkspaceHandler;

  const fakeEChartsLoader = async () => ({
    init(target, theme, options) {
      initCalls += 1;
      return {
        setOption(option) {
          setOptionCalls += 1;
          target.__option = option;
        },
        resize() {},
        dispose() {
          disposeCalls += 1;
        },
      };
    },
  });

  const activate = clientPlugin.createActivate(fakeEChartsLoader);
  await activate({
    onPreviewRendered(handler) {
      registeredPreviewHandler = handler;
    },
    onPreviewCleared(handler) {
      registeredClearHandler = handler;
    },
    onWorkspaceChanged(handler) {
      registeredWorkspaceHandler = handler;
    },
  });

  assert(typeof registeredPreviewHandler === "function", "Expected client plugin to register a preview hook.");
  assert(typeof registeredClearHandler === "function", "Expected client plugin to register a clear hook.");
  assert(typeof registeredWorkspaceHandler === "function", "Expected client plugin to register a workspace hook.");

  await registeredPreviewHandler({
    previewElement,
  });

  assert(initCalls === 1, "Expected echarts runtime to initialize one chart.");
  assert(setOptionCalls === 1, "Expected chart option to be applied once.");
  assert(fakeBlock.dataset.echartsState === "rendered", "Expected block state to be updated after rendering.");
  assert(fakeBlock.fallback.hidden === true, "Expected fallback to be hidden after rendering.");
  assert(fakeBlock.renderTarget.style.height === "360px", "Expected default chart height to be applied.");
  assert(previewElement.ownerDocument.getElementById("md-reader-echarts-plugin-style"), "Expected plugin styles to be injected.");

  await registeredClearHandler();
  await registeredWorkspaceHandler();
  assert(disposeCalls >= 1, "Expected chart instance to be disposed during cleanup.");

  const wrappedOption = clientPlugin.normalizeChartPayload(
    clientPlugin.parseOptionSource("({ height: 480, renderer: 'svg', option: { series: [] } })")
  );
  assert(wrappedOption.height === 480, "Expected wrapped chart payload to preserve explicit height.");
  assert(wrappedOption.renderer === "svg", "Expected wrapped chart payload to preserve explicit renderer.");
}

await testServerPlugin();
await testClientPlugin();
console.log("ECharts plugin tests passed.");
