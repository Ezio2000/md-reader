const pluginsDirectoryElement = document.querySelector("#plugins-directory");
const pluginsStateFileElement = document.querySelector("#plugins-state-file");
const pluginsCountElement = document.querySelector("#plugins-count");
const pluginsFeedbackElement = document.querySelector("#plugins-feedback");
const pluginsListElement = document.querySelector("#plugins-list");
const pluginsEmptyElement = document.querySelector("#plugins-empty");
const pluginsReloadButton = document.querySelector("#plugins-reload");

function setPluginsFeedback(message, tone = "neutral") {
  pluginsFeedbackElement.dataset.tone = tone;
  pluginsFeedbackElement.textContent = message;
}

function setReloadLoading(isLoading) {
  pluginsReloadButton.disabled = isLoading;
  pluginsReloadButton.textContent = isLoading ? "扫描中…" : "重新扫描插件";
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

function createCapabilityBadge(label) {
  const badge = document.createElement("span");
  badge.className = "plugin-badge";
  badge.textContent = label;
  return badge;
}

function createPluginDetail(label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  const code = document.createElement("code");

  term.textContent = label;
  code.textContent = value;
  description.append(code);
  wrapper.append(term, description);

  return wrapper;
}

function renderPluginCard(plugin) {
  const card = document.createElement("article");
  card.className = "plugin-card";
  card.dataset.status = plugin.status;

  const header = document.createElement("div");
  header.className = "plugin-card-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "plugin-title-group";

  const title = document.createElement("h3");
  title.textContent = plugin.name;

  const version = document.createElement("small");
  version.textContent = `${plugin.id} · v${plugin.version}`;
  titleGroup.append(title, version);

  const status = document.createElement("span");
  status.className = "status-chip";
  status.dataset.status = plugin.status;
  status.textContent = plugin.status;

  header.append(titleGroup, status);

  const description = document.createElement("p");
  description.className = "plugin-description";
  description.textContent = plugin.description || "这个插件还没有提供描述。";

  const details = document.createElement("dl");
  details.className = "plugin-details";
  details.append(
    createPluginDetail("目录", plugin.directory),
    createPluginDetail("Manifest", plugin.manifestPath),
    createPluginDetail("服务端入口", plugin.serverEntry || "无"),
    createPluginDetail("客户端入口", plugin.clientEntry || "无")
  );

  const capabilityRow = document.createElement("div");
  capabilityRow.className = "plugin-badge-row";
  capabilityRow.append(
    createCapabilityBadge(plugin.enabled ? "已启用" : "已禁用"),
    createCapabilityBadge(plugin.hasServerEntry ? "server" : "no-server"),
    createCapabilityBadge(plugin.hasClientEntry ? "client" : "no-client")
  );

  if (plugin.permissions.length) {
    for (const permission of plugin.permissions) {
      capabilityRow.append(createCapabilityBadge(permission));
    }
  }

  const hookSection = document.createElement("div");
  hookSection.className = "plugin-hook-list";
  if (plugin.hooks.length) {
    for (const hook of plugin.hooks) {
      hookSection.append(createCapabilityBadge(hook));
    }
  } else {
    hookSection.append(createCapabilityBadge("未注册 hooks"));
  }

  const footer = document.createElement("div");
  footer.className = "plugin-card-footer";

  const info = document.createElement("p");
  info.className = "plugin-card-hint";
  info.textContent = plugin.hasClientEntry
    ? "包含客户端入口。切换状态后请刷新阅读器页面。"
    : "当前只有宿主端能力。";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = plugin.enabled ? "toolbar-button secondary-button" : "toolbar-button";
  toggleButton.disabled = plugin.status === "invalid";
  toggleButton.textContent = plugin.enabled ? "禁用插件" : "启用插件";
  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    setPluginsFeedback(`正在更新插件 ${plugin.name} 的状态…`);

    try {
      await fetchJson(`/api/plugins/${encodeURIComponent(plugin.id)}/state`, {
        method: "POST",
        body: JSON.stringify({
          enabled: !plugin.enabled,
        }),
      });
      await loadPlugins(`插件 ${plugin.name} 状态已更新。`, "success");
    } catch (error) {
      setPluginsFeedback(error.message, "error");
    } finally {
      toggleButton.disabled = plugin.status === "invalid";
    }
  });

  footer.append(info, toggleButton);

  card.append(header, description, details, capabilityRow, hookSection);
  if (plugin.error) {
    const errorElement = document.createElement("p");
    errorElement.className = "plugin-error";
    errorElement.textContent = plugin.error;
    card.append(errorElement);
  }
  card.append(footer);

  return card;
}

function renderPlugins(payload) {
  pluginsDirectoryElement.textContent = payload.directory;
  pluginsStateFileElement.textContent = payload.stateFilePath;
  pluginsCountElement.textContent = String(payload.items.length);
  pluginsListElement.innerHTML = "";
  pluginsEmptyElement.hidden = payload.items.length > 0;

  for (const plugin of payload.items) {
    pluginsListElement.append(renderPluginCard(plugin));
  }
}

async function loadPlugins(successMessage = "插件列表已刷新。", tone = "success") {
  const payload = await fetchJson("/api/plugins");
  renderPlugins(payload);
  setPluginsFeedback(successMessage, tone);
}

pluginsReloadButton.addEventListener("click", async () => {
  setReloadLoading(true);
  setPluginsFeedback("正在重新扫描插件目录…");

  try {
    const payload = await fetchJson("/api/plugins/reload", {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderPlugins(payload);
    setPluginsFeedback("插件目录扫描完成。", "success");
  } catch (error) {
    setPluginsFeedback(error.message, "error");
  } finally {
    setReloadLoading(false);
  }
});

async function initializePage() {
  setReloadLoading(true);

  try {
    await loadPlugins("插件列表已加载。");
  } catch (error) {
    setPluginsFeedback(error.message, "error");
  } finally {
    setReloadLoading(false);
  }
}

void initializePage();
