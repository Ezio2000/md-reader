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

const treeCache = new Map();
const expandedPaths = new Set([""]);
let activeFilePath = "";

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

  applyWorkspacePayload(payload);
}

function applyWorkspacePayload(payload) {
  treeCache.clear();
  treeCache.set("", payload.items);
  expandedPaths.clear();
  expandedPaths.add("");
  activeFilePath = "";

  workspacePathInput.value = payload.rootPath;
  currentRootElement.textContent = payload.rootPath;
  previewTitleElement.textContent = "Markdown 预览";
  previewPathElement.textContent = "";
  setPreviewStatus("从左侧选择一个 `.md` 文件开始预览。");

  renderTree();
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

    applyWorkspacePayload(payload);
    setWorkspaceFeedback("已通过系统文件夹选择器切换工作目录。", "success");
  } catch (error) {
    setWorkspaceFeedback(error.message, "error");
  } finally {
    setWorkspacePickerLoading(false);
  }
}

async function loadChildren(path) {
  if (treeCache.has(path)) {
    return treeCache.get(path);
  }

  const payload = await fetchJson(`/api/tree?path=${encodeURIComponent(path)}`);
  treeCache.set(path, payload.items);
  return payload.items;
}

async function openMarkdownFile(path) {
  activeFilePath = path;
  previewTitleElement.textContent = "正在加载…";
  previewPathElement.textContent = path;
  setPreviewStatus("正在读取 Markdown 文件…");
  renderTree();

  try {
    const payload = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
    previewTitleElement.textContent = payload.name;
    previewPathElement.textContent = payload.path;
    showPreview(payload.html);
  } catch (error) {
    setPreviewStatus(error.message);
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
        renderTree();
        return;
      }

      expandedPaths.add(item.path);
      renderTree();

      if (!treeCache.has(item.path)) {
        childrenContainer.innerHTML = '<div class="tree-placeholder">正在加载…</div>';
      }

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

async function initializeApp() {
  setTreeStatus("正在加载工作目录…");
  setWorkspaceFeedback("可输入绝对路径，或直接打开系统文件夹选择器。");
  setPreviewStatus("从左侧选择一个 `.md` 文件开始预览。");

  try {
    await loadWorkspace();
  } catch (error) {
    setTreeStatus(error.message);
    setWorkspaceFeedback("初始工作目录加载失败。你可以手动输入路径或使用系统文件夹选择器。", "error");
  }
}

void initializeApp();
