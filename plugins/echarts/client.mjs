const STYLE_ELEMENT_ID = "md-reader-echarts-plugin-style";
let echartsModulePromise;
const activeChartCleanups = [];

function decodeBase64(base64Value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64Value, "base64");
  }

  const binary = atob(base64Value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeChartSource(encodedSource) {
  if (!encodedSource) {
    return "";
  }

  const bytes = decodeBase64(encodedSource);
  return new TextDecoder().decode(bytes);
}

export function ensureEChartsStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const styleElement = doc.createElement("style");
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.textContent = `
    .md-echarts-block {
      margin: 0 0 1.25rem;
      border: 1px solid rgba(92, 71, 39, 0.14);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.54);
      overflow: hidden;
    }

    .md-echarts-render {
      min-height: 360px;
      padding: 18px;
    }

    .md-echarts-error {
      padding: 14px 18px 0;
      color: #934225;
      font-size: 0.94rem;
      white-space: pre-wrap;
    }

    .md-echarts-block[data-echarts-state="rendered"] .md-echarts-fallback {
      display: none;
    }

    .md-echarts-block[data-echarts-state="error"] .md-echarts-render {
      display: none;
    }

    .md-echarts-fallback {
      margin: 0;
      border-top: 1px solid rgba(92, 71, 39, 0.08);
    }
  `;
  doc.head.append(styleElement);
}

export function getEChartsBlocks(previewElement) {
  if (!previewElement?.querySelectorAll) {
    return [];
  }

  return Array.from(previewElement.querySelectorAll(".md-echarts-block[data-echarts-source]"));
}

function loadEChartsModule() {
  if (!echartsModulePromise) {
    echartsModulePromise = import("./vendor/echarts.esm.min.mjs");
  }

  return echartsModulePromise;
}

export function parseOptionSource(source) {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("ECharts option block is empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch (jsonError) {
    try {
      return Function(`"use strict"; return (${trimmed});`)();
    } catch (expressionError) {
      throw new Error(`Failed to parse ECharts option block.\n${expressionError instanceof Error ? expressionError.message : String(expressionError)}`);
    }
  }
}

export function normalizeChartPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new Error("ECharts option block must evaluate to an object.");
  }

  const payload = Object.prototype.hasOwnProperty.call(rawPayload, "option") ? rawPayload : { option: rawPayload };
  if (!payload.option || typeof payload.option !== "object" || Array.isArray(payload.option)) {
    throw new Error("ECharts payload must contain an object option.");
  }

  const normalizedHeight = Number(payload.height || 360);
  return {
    option: payload.option,
    theme: payload.theme ?? null,
    height: Number.isFinite(normalizedHeight) && normalizedHeight > 0 ? normalizedHeight : 360,
    renderer: payload.renderer === "svg" ? "svg" : "canvas",
  };
}

function registerCleanup(cleanup) {
  activeChartCleanups.push(cleanup);
}

function cleanupActiveCharts() {
  while (activeChartCleanups.length > 0) {
    const cleanup = activeChartCleanups.pop();
    try {
      cleanup();
    } catch (error) {
      console.error("Failed to cleanup ECharts instance", error);
    }
  }
}

export async function renderEChartsBlock(block, { echarts }) {
  const renderTarget = block.querySelector(".md-echarts-render");
  const errorTarget = block.querySelector(".md-echarts-error");
  const fallback = block.querySelector(".md-echarts-fallback");
  const source = decodeChartSource(block.dataset.echartsSource);

  block.dataset.echartsState = "rendering";
  if (errorTarget) {
    errorTarget.hidden = true;
    errorTarget.textContent = "";
  }

  try {
    const parsedPayload = normalizeChartPayload(parseOptionSource(source));
    renderTarget.style.height = `${parsedPayload.height}px`;

    const chart = echarts.init(renderTarget, parsedPayload.theme, {
      renderer: parsedPayload.renderer,
    });
    chart.setOption(parsedPayload.option, true);

    let resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        chart.resize();
      });
      resizeObserver.observe(renderTarget);
    }

    const cleanup = () => {
      resizeObserver?.disconnect();
      chart.dispose();
    };

    registerCleanup(cleanup);

    if (fallback) {
      fallback.hidden = true;
    }
    block.dataset.echartsState = "rendered";
    return true;
  } catch (error) {
    if (errorTarget) {
      errorTarget.hidden = false;
      errorTarget.textContent = error instanceof Error ? error.message : String(error);
    }
    if (fallback) {
      fallback.hidden = false;
    }
    block.dataset.echartsState = "error";
    return false;
  }
}

export async function renderEChartsBlocks({ previewElement, loadECharts = loadEChartsModule } = {}) {
  const blocks = getEChartsBlocks(previewElement);
  if (!blocks.length) {
    cleanupActiveCharts();
    return {
      count: 0,
      rendered: 0,
    };
  }

  ensureEChartsStyles(previewElement?.ownerDocument ?? globalThis.document);
  cleanupActiveCharts();
  const echarts = await loadECharts();

  let renderedCount = 0;
  for (const block of blocks) {
    if (await renderEChartsBlock(block, { echarts })) {
      renderedCount += 1;
    }
  }

  return {
    count: blocks.length,
    rendered: renderedCount,
  };
}

export function createActivate(loadECharts = loadEChartsModule) {
  return async function activate(api) {
    api.onPreviewRendered(async ({ previewElement }) => {
      await renderEChartsBlocks({
        previewElement,
        loadECharts,
      });
    });

    api.onPreviewCleared(async () => {
      cleanupActiveCharts();
    });

    api.onWorkspaceChanged(async () => {
      cleanupActiveCharts();
    });
  };
}

export const activate = createActivate();
