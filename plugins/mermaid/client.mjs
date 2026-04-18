const STYLE_ELEMENT_ID = "md-reader-mermaid-plugin-style";
const MERMAID_INIT_OPTIONS = {
  startOnLoad: false,
  securityLevel: "loose",
  theme: "default",
  htmlLabels: false,
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
  },
};
let mermaidModulePromise;
let mermaidInitialized = false;
let renderSequence = 0;

function decodeBase64(base64Value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64Value, "base64");
  }

  const binary = atob(base64Value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function decodeMermaidSource(encodedSource) {
  if (!encodedSource) {
    return "";
  }

  const bytes = decodeBase64(encodedSource);
  return new TextDecoder().decode(bytes);
}

export function ensureMermaidStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const styleElement = doc.createElement("style");
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.textContent = `
    .md-mermaid-block {
      margin: 0 0 1.25rem;
      border: 1px solid rgba(92, 71, 39, 0.14);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.54);
      overflow: hidden;
    }

    .md-mermaid-render {
      padding: 18px;
      overflow-x: auto;
      text-align: center;
    }

    .md-mermaid-render svg {
      max-width: 100%;
      height: auto;
    }

    .md-mermaid-error {
      padding: 14px 18px 0;
      color: #934225;
      font-size: 0.94rem;
    }

    .md-mermaid-block[data-mermaid-state="rendered"] .md-mermaid-fallback {
      display: none;
    }

    .md-mermaid-block[data-mermaid-state="rendered"] .md-mermaid-render {
      display: block;
    }

    .md-mermaid-block[data-mermaid-state="error"] .md-mermaid-render {
      display: none;
    }

    .md-mermaid-fallback {
      margin: 0;
      border-top: 1px solid rgba(92, 71, 39, 0.08);
    }
  `;
  doc.head.append(styleElement);
}

export function getMermaidBlocks(previewElement) {
  if (!previewElement?.querySelectorAll) {
    return [];
  }

  return Array.from(previewElement.querySelectorAll(".md-mermaid-block[data-mermaid-source]"));
}

async function loadMermaidModule() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("./vendor/mermaid.esm.min.mjs").then((module) => module.default ?? module.mermaid ?? module);
  }

  return mermaidModulePromise;
}

async function getMermaidApi(loadMermaid = loadMermaidModule) {
  const mermaid = await loadMermaid();

  if (!mermaidInitialized) {
    mermaid.initialize(MERMAID_INIT_OPTIONS);
    mermaidInitialized = true;
  }

  return mermaid;
}

function waitForAnimationFrame() {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return new Promise((resolve) => {
      globalThis.requestAnimationFrame(() => resolve());
    });
  }

  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 16);
  });
}

async function waitForFonts(doc = globalThis.document) {
  const fontSet = doc?.fonts;
  if (!fontSet?.ready || typeof fontSet.ready.then !== "function") {
    return;
  }

  try {
    await fontSet.ready;
  } catch {
    // Ignore font loading failures and continue with rendering.
  }
}

function resolveRenderResult(result) {
  if (typeof result === "string") {
    return {
      svg: result,
      bindFunctions: null,
    };
  }

  return {
    svg: result?.svg || "",
    bindFunctions: result?.bindFunctions || null,
  };
}

export async function renderMermaidBlock(block, { mermaid }) {
  const renderTarget = block.querySelector(".md-mermaid-render");
  const errorTarget = block.querySelector(".md-mermaid-error");
  const fallback = block.querySelector(".md-mermaid-fallback");
  const encodedSource = block.dataset.mermaidSource;
  const source = decodeMermaidSource(encodedSource);
  const diagramId = `md-reader-mermaid-${++renderSequence}`;

  block.dataset.mermaidState = "rendering";
  if (errorTarget) {
    errorTarget.hidden = true;
    errorTarget.textContent = "";
  }

  try {
    const result = resolveRenderResult(await mermaid.render(diagramId, source));
    if (renderTarget) {
      renderTarget.innerHTML = result.svg;
      if (typeof result.bindFunctions === "function") {
        result.bindFunctions(renderTarget);
      }
    }

    if (fallback) {
      fallback.hidden = true;
    }
    block.dataset.mermaidState = "rendered";
    return true;
  } catch (error) {
    if (errorTarget) {
      errorTarget.hidden = false;
      errorTarget.textContent = error instanceof Error ? error.message : String(error);
    }

    if (fallback) {
      fallback.hidden = false;
    }
    block.dataset.mermaidState = "error";
    return false;
  }
}

export async function renderMermaidBlocks({ previewElement, loadMermaid = loadMermaidModule } = {}) {
  const blocks = getMermaidBlocks(previewElement);
  if (!blocks.length) {
    return {
      count: 0,
      rendered: 0,
    };
  }

  const documentRef = previewElement?.ownerDocument ?? globalThis.document;
  ensureMermaidStyles(documentRef);
  await waitForFonts(documentRef);
  await waitForAnimationFrame();
  const mermaid = await getMermaidApi(loadMermaid);

  let renderedCount = 0;
  for (const block of blocks) {
    if (await renderMermaidBlock(block, { mermaid })) {
      renderedCount += 1;
    }
  }

  return {
    count: blocks.length,
    rendered: renderedCount,
  };
}

export function createActivate(loadMermaid = loadMermaidModule) {
  return async function activate(api) {
    api.onPreviewRendered(async ({ previewElement }) => {
      await renderMermaidBlocks({
        previewElement,
        loadMermaid,
      });
    });
  };
}

export const activate = createActivate();
export { MERMAID_INIT_OPTIONS, waitForAnimationFrame, waitForFonts };
