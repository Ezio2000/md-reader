const workspaceForm = document.querySelector("#workspace-form");
const workspacePathInput = document.querySelector("#workspace-path");
const workspacePickerButton = document.querySelector("#workspace-picker");
const workspaceSubmitButton = document.querySelector("#workspace-submit");
const workspaceFeedbackElement = document.querySelector("#workspace-feedback");
const currentRootElement = document.querySelector("#current-root");
const treeStatusElement = document.querySelector("#tree-status");
const treeRootElement = document.querySelector("#tree-root");
const previewTitleElement = document.querySelector("#preview-title");
const previewPathElement = document.querySelector("#preview-path");
const previewStatusElement = document.querySelector("#preview-status");
const previewContentElement = document.querySelector("#preview-content");
const summaryButtonElement = document.querySelector("#summary-button");
const summaryModalElement = document.querySelector("#summary-modal");
const summaryCloseButtonElement = document.querySelector("#summary-close");
const summaryMetaElement = document.querySelector("#summary-meta");
const summaryBodyElement = document.querySelector("#summary-body");

const treeCache = new Map();
const expandedPaths = new Set([""]);
let activeFilePath = "";
let activeFileName = "";
let summaryRequestToken = 0;

function createPluginHost() {
  const previewRenderedHandlers = [];
  const previewClearedHandlers = [];
  const workspaceChangedHandlers = [];

  return {
    async load() {
      const runtime = await fetchJson("/api/plugins/runtime");

      for (const moduleDescriptor of runtime.modules) {
        try {
          const pluginModule = await import(moduleDescriptor.url);
          const activate = typeof pluginModule.activate === "function" ? pluginModule.activate : pluginModule.default?.activate;
          if (typeof activate !== "function") {
            continue;
          }

          await activate({
            plugin: moduleDescriptor,
            onPreviewRendered(handler) {
              if (typeof handler === "function") {
                previewRenderedHandlers.push({
                  pluginId: moduleDescriptor.id,
                  handler,
                });
              }
            },
            onPreviewCleared(handler) {
              if (typeof handler === "function") {
                previewClearedHandlers.push({
                  pluginId: moduleDescriptor.id,
                  handler,
                });
              }
            },
            onWorkspaceChanged(handler) {
              if (typeof handler === "function") {
                workspaceChangedHandlers.push({
                  pluginId: moduleDescriptor.id,
                  handler,
                });
              }
            },
            getPreviewElement() {
              return previewContentElement;
            },
          });
        } catch (error) {
          console.error(`Failed to load client plugin "${moduleDescriptor.id}"`, error);
        }
      }
    },
    async emitPreviewRendered(payload) {
      for (const listener of previewRenderedHandlers) {
        try {
          await listener.handler(payload);
        } catch (error) {
          console.error(`Preview hook failed for plugin "${listener.pluginId}"`, error);
        }
      }
    },
    async emitPreviewCleared(payload) {
      for (const listener of previewClearedHandlers) {
        try {
          await listener.handler(payload);
        } catch (error) {
          console.error(`Preview clear hook failed for plugin "${listener.pluginId}"`, error);
        }
      }
    },
    async emitWorkspaceChanged(payload) {
      for (const listener of workspaceChangedHandlers) {
        try {
          await listener.handler(payload);
        } catch (error) {
          console.error(`Workspace hook failed for plugin "${listener.pluginId}"`, error);
        }
      }
    },
  };
}

const pluginHost = createPluginHost();

function setWorkspaceFeedback(message, tone = "neutral") {
  workspaceFeedbackElement.dataset.tone = tone;
  workspaceFeedbackElement.textContent = message;
}

function setWorkspacePickerLoading(isLoading) {
  workspacePickerButton.disabled = isLoading;
  workspaceSubmitButton.disabled = isLoading;
  workspacePathInput.disabled = isLoading;
  workspacePickerButton.textContent = isLoading ? "选择中…" : "选择文件夹";
}

function setTreeStatus(message) {
  treeStatusElement.hidden = false;
  treeStatusElement.textContent = message;
}

function hideTreeStatus() {
  treeStatusElement.hidden = true;
}

function setPreviewStatus(message) {
  previewStatusElement.hidden = false;
  previewStatusElement.textContent = message;
  previewContentElement.hidden = true;
  previewContentElement.innerHTML = "";
}

function showPreview(html) {
  previewStatusElement.hidden = true;
  previewContentElement.hidden = false;
  previewContentElement.innerHTML = html;
}

function updateSummaryButtonState() {
  summaryButtonElement.disabled = !activeFilePath;
}

function setSummaryButtonLoading(isLoading) {
  summaryButtonElement.disabled = isLoading || !activeFilePath;
  summaryButtonElement.textContent = isLoading ? "生成中…" : "AI 总结";
}

function openSummaryModal() {
  summaryModalElement.hidden = false;
}

function closeSummaryModal() {
  summaryModalElement.hidden = true;
}

function setSummaryModalState(meta, body, tone = "neutral") {
  summaryMetaElement.dataset.tone = tone;
  summaryMetaElement.textContent = meta;
  summaryBodyElement.textContent = body;
}

async function requestAiSummary() {
  if (!activeFilePath) {
    return;
  }

  const requestToken = ++summaryRequestToken;
  setSummaryButtonLoading(true);
  openSummaryModal();
  setSummaryModalState(`正在为 ${activeFileName || activeFilePath} 生成摘要…`, "请稍候，正在调用 AI。");

  try {
    const payload = await fetchJson("/api/ai-summary", {
      method: "POST",
      body: JSON.stringify({
        path: activeFilePath,
      }),
    });

    if (requestToken !== summaryRequestToken) {
      return;
    }

    const metaParts = [`文件：${payload.name}`, `模型：${payload.model}`];
    if (payload.truncated) {
      metaParts.push("正文已截断");
    }

    setSummaryModalState(metaParts.join(" · "), payload.summary, "success");
  } catch (error) {
    if (requestToken !== summaryRequestToken) {
      return;
    }

    setSummaryModalState("AI 总结生成失败", error.message, "error");
  } finally {
    if (requestToken === summaryRequestToken) {
      setSummaryButtonLoading(false);
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

async function loadWorkspace(rootPath) {
  const payload = rootPath
    ? await fetchJson("/api/workspace", {
        method: "POST",
        body: JSON.stringify({ rootPath }),
      })
    : await fetchJson("/api/workspace");

  await applyWorkspacePayload(payload);
}

async function applyWorkspacePayload(payload) {
  treeCache.clear();
  treeCache.set("", payload.items);
  expandedPaths.clear();
  expandedPaths.add("");
  activeFilePath = "";
  activeFileName = "";
  summaryRequestToken += 1;

  workspacePathInput.value = payload.rootPath;
  currentRootElement.textContent = payload.rootPath;
  previewTitleElement.textContent = "Markdown 预览";
  previewPathElement.textContent = "";
  setPreviewStatus("从左侧选择一个 `.md` 文件开始预览。");
  updateSummaryButtonState();
  closeSummaryModal();
  setSummaryModalState("选择一个 Markdown 文件后可生成摘要。", "点击“AI 总结”后将在这里显示摘要。");
  await pluginHost.emitPreviewCleared({
    reason: "workspace-change",
  });

  renderTree();
  await pluginHost.emitWorkspaceChanged({
    rootPath: payload.rootPath,
  });
}

async function chooseWorkspaceFromSystem() {
  setWorkspacePickerLoading(true);
  setWorkspaceFeedback("正在打开系统文件夹选择器…");

  try {
    const payload = await fetchJson("/api/system-directory-picker", {
      method: "POST",
      body: JSON.stringify({}),
    });

    if (payload.cancelled) {
      setWorkspaceFeedback("已取消选择文件夹。");
      return;
    }

    await applyWorkspacePayload(payload);
    setWorkspaceFeedback("已通过系统文件夹选择器切换工作目录。", "success");
  } catch (error) {
    setWorkspaceFeedback(error.message, "error");
  } finally {
    setWorkspacePickerLoading(false);
  }
}

async function loadChildren(path) {
  const payload = await fetchJson(`/api/tree?path=${encodeURIComponent(path)}`);
  treeCache.set(path, payload.items);
  return payload.items;
}

async function openMarkdownFile(path) {
  activeFilePath = path;
  activeFileName = path.split("/").pop() || path;
  previewTitleElement.textContent = "正在加载…";
  previewPathElement.textContent = path;
  setPreviewStatus("正在读取 Markdown 文件…");
  updateSummaryButtonState();
  renderTree();

  try {
    const payload = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
    activeFileName = payload.name;
    previewTitleElement.textContent = payload.name;
    previewPathElement.textContent = payload.path;
    showPreview(payload.html);
    await pluginHost.emitPreviewRendered({
      filePath: payload.path,
      title: payload.name,
      rootPath: currentRootElement.textContent,
      previewElement: previewContentElement,
      pluginMeta: payload.pluginMeta || {},
    });
  } catch (error) {
    setPreviewStatus(error.message);
    activeFilePath = "";
    activeFileName = "";
    updateSummaryButtonState();
    await pluginHost.emitPreviewCleared({
      reason: "preview-error",
      error: error.message,
    });
  }
}

function createTreeItem(item) {
  const listItem = document.createElement("li");
  listItem.className = "tree-item";
  listItem.dataset.type = item.type;
  listItem.dataset.path = item.path;
  listItem.dataset.expanded = expandedPaths.has(item.path);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  if (item.type === "file" && activeFilePath === item.path) {
    row.classList.add("active");
  }

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = item.type === "directory" && item.hasChildren ? "▸" : "";

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = item.type === "directory" ? "📁" : "📄";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = item.name;

  row.append(caret, icon, label);
  listItem.append(row);

  if (item.type === "directory") {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";
    childrenContainer.hidden = !expandedPaths.has(item.path);
    listItem.append(childrenContainer);

    row.addEventListener("click", async () => {
      if (!item.hasChildren) {
        return;
      }

      const isExpanded = expandedPaths.has(item.path);
      if (isExpanded) {
        expandedPaths.delete(item.path);
        treeCache.delete(item.path);
        renderTree();
        return;
      }

      expandedPaths.add(item.path);
      renderTree();

      childrenContainer.innerHTML = '<div class="tree-placeholder">正在加载…</div>';

      try {
        await loadChildren(item.path);
      } catch (error) {
        childrenContainer.innerHTML = `<div class="tree-empty">${error.message}</div>`;
      }

      renderTree();
    });
  } else {
    row.addEventListener("click", () => {
      void openMarkdownFile(item.path);
    });
  }

  return listItem;
}

function renderTreeBranch(items, parentPath = "") {
  const list = document.createElement("ul");
  list.className = "tree-list";
  if (parentPath) {
    list.dataset.parentPath = parentPath;
  }

  if (!items.length) {
    const emptyState = document.createElement("li");
    emptyState.className = "tree-empty";
    emptyState.textContent = "当前目录没有可见的 Markdown 文件。";
    list.append(emptyState);
    return list;
  }

  for (const item of items) {
    const listItem = createTreeItem(item);
    list.append(listItem);

    if (item.type === "directory" && expandedPaths.has(item.path)) {
      const childrenHost = listItem.querySelector(".tree-children");
      const children = treeCache.get(item.path);

      if (children) {
        childrenHost.innerHTML = "";
        childrenHost.append(renderTreeBranch(children, item.path));
      } else {
        childrenHost.innerHTML = '<div class="tree-placeholder">正在加载…</div>';
      }
    }
  }

  return list;
}

function renderTree() {
  const rootItems = treeCache.get("") || [];
  treeRootElement.hidden = false;
  hideTreeStatus();
  treeRootElement.innerHTML = "";
  treeRootElement.append(renderTreeBranch(rootItems));
}

workspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const nextRoot = workspacePathInput.value.trim();
  if (!nextRoot) {
    setWorkspaceFeedback("请输入一个目录绝对路径，或直接使用“选择文件夹”。", "error");
    return;
  }

  setWorkspacePickerLoading(true);
  setWorkspaceFeedback("正在切换工作目录…");

  try {
    await loadWorkspace(nextRoot);
    setWorkspaceFeedback("已根据输入路径切换工作目录。", "success");
  } catch (error) {
    setWorkspaceFeedback(error.message, "error");
  } finally {
    setWorkspacePickerLoading(false);
  }
});

workspacePickerButton.addEventListener("click", () => {
  void chooseWorkspaceFromSystem();
});

summaryButtonElement.addEventListener("click", () => {
  void requestAiSummary();
});

summaryCloseButtonElement.addEventListener("click", () => {
  closeSummaryModal();
});

async function initializeApp() {
  setTreeStatus("正在加载工作目录…");
  setWorkspaceFeedback("可输入绝对路径，或直接打开系统文件夹选择器。");
  setPreviewStatus("从左侧选择一个 `.md` 文件开始预览。");
  updateSummaryButtonState();
  closeSummaryModal();
  setSummaryModalState("选择一个 Markdown 文件后可生成摘要。", "点击“AI 总结”后将在这里显示摘要。");

  try {
    await pluginHost.load();
  } catch (error) {
    console.error("Failed to bootstrap client plugins", error);
    setWorkspaceFeedback("插件运行时加载失败，阅读器仍可正常使用。", "error");
  }

  try {
    await loadWorkspace();
  } catch (error) {
    setTreeStatus(error.message);
    setWorkspaceFeedback("初始工作目录加载失败。你可以手动输入路径或使用系统文件夹选择器。", "error");
  }
}

void initializeApp();
