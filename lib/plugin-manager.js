const fs = require("fs/promises");
const path = require("path");

const MANIFEST_FILE_NAME = "plugin.json";
const STATE_FILE_NAME = "plugins-state.json";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ensurePathInsideDirectory(baseDirectory, candidatePath, fieldName) {
  const normalizedBase = path.resolve(baseDirectory);
  const normalizedCandidate = path.resolve(candidatePath);
  const prefix = `${normalizedBase}${path.sep}`;

  if (normalizedCandidate !== normalizedBase && !normalizedCandidate.startsWith(prefix)) {
    throw new Error(`${fieldName} must stay inside the plugin directory.`);
  }

  return normalizedCandidate;
}

function normalizeRelativePluginFile(pluginDirectory, value, fieldName) {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string when provided.`);
  }

  const normalizedRelativePath = value.trim().replaceAll("\\", "/");
  const absolutePath = ensurePathInsideDirectory(pluginDirectory, path.resolve(pluginDirectory, normalizedRelativePath), fieldName);

  return {
    relativePath: normalizedRelativePath,
    absolutePath,
  };
}

function pickLifecycleFunction(moduleExports, key) {
  if (typeof moduleExports?.[key] === "function") {
    return moduleExports[key];
  }

  if (typeof moduleExports?.default?.[key] === "function") {
    return moduleExports.default[key];
  }

  return null;
}

class PluginManager {
  constructor({ rootDirectory, logger = console }) {
    this.rootDirectory = rootDirectory;
    this.logger = logger;
    this.pluginsDirectory = process.env.MD_READER_PLUGIN_DIR
      ? path.resolve(process.env.MD_READER_PLUGIN_DIR)
      : path.join(rootDirectory, "plugins");
    this.stateDirectory = process.env.MD_READER_STATE_DIR
      ? path.resolve(process.env.MD_READER_STATE_DIR)
      : path.join(rootDirectory, ".md-reader");
    this.stateFilePath = path.join(this.stateDirectory, STATE_FILE_NAME);
    this.runtimeVersion = 0;
    this.state = {};
    this.plugins = [];
    this.pluginsById = new Map();
    this.activePluginLifecycles = [];
    this.markdownTransformers = [];
    this.treeTransformers = [];
    this.clientModules = [];
  }

  async initialize() {
    await fs.mkdir(this.pluginsDirectory, { recursive: true });
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await this.reload();
  }

  async reload() {
    await this.deactivatePlugins();
    this.state = await this.readState();
    this.plugins = [];
    this.pluginsById = new Map();
    this.markdownTransformers = [];
    this.treeTransformers = [];
    this.clientModules = [];

    const discoveredPlugins = await this.discoverPlugins();
    discoveredPlugins.sort((left, right) => {
      return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    });

    for (const plugin of discoveredPlugins) {
      this.plugins.push(plugin);
      if (!plugin.id || this.pluginsById.has(plugin.id)) {
        continue;
      }

      this.pluginsById.set(plugin.id, plugin);
      if (plugin.enabled && plugin.status !== "invalid") {
        await this.activatePlugin(plugin);
      }
    }

    this.runtimeVersion += 1;
    return this.getManagementPayload();
  }

  async setPluginEnabled(pluginId, enabled) {
    const plugin = this.pluginsById.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" was not found.`);
    }

    if (plugin.status === "invalid") {
      throw new Error(`Plugin "${pluginId}" has an invalid manifest and cannot be toggled.`);
    }

    if (enabled === plugin.defaultEnabled) {
      delete this.state[pluginId];
    } else {
      this.state[pluginId] = { enabled };
    }

    await this.writeState();
    await this.reload();
    return this.getPluginById(pluginId);
  }

  getPluginById(pluginId) {
    return this.serializePlugin(this.pluginsById.get(pluginId));
  }

  getManagementPayload() {
    return {
      directory: this.pluginsDirectory,
      stateFilePath: this.stateFilePath,
      runtimeVersion: this.runtimeVersion,
      items: this.plugins.map((plugin) => this.serializePlugin(plugin)),
    };
  }

  getClientRuntimePayload() {
    return {
      version: this.runtimeVersion,
      modules: this.clientModules.map((clientModule) => ({ ...clientModule })),
    };
  }

  async applyMarkdownTransformers(payload) {
    let nextPayload = {
      ...payload,
      meta: payload.meta || {},
    };

    for (const transformer of this.markdownTransformers) {
      try {
        const result = await transformer.handler({ ...nextPayload });
        if (!result || typeof result !== "object") {
          continue;
        }

        if (typeof result.raw === "string") {
          nextPayload.raw = result.raw;
        }

        if (typeof result.html === "string") {
          nextPayload.html = result.html;
        }

        if (result.meta && typeof result.meta === "object" && !Array.isArray(result.meta)) {
          nextPayload.meta = {
            ...nextPayload.meta,
            ...result.meta,
          };
        }
      } catch (error) {
        this.logger.error(`[plugin:${transformer.pluginId}] Markdown transformer "${transformer.name}" failed: ${toErrorMessage(error)}`);
      }
    }

    return nextPayload;
  }

  async applyTreeTransformers(payload) {
    let items = payload.items;

    for (const transformer of this.treeTransformers) {
      try {
        const result = await transformer.handler({
          ...payload,
          items,
        });

        if (Array.isArray(result)) {
          items = result;
          continue;
        }

        if (result && Array.isArray(result.items)) {
          items = result.items;
        }
      } catch (error) {
        this.logger.error(`[plugin:${transformer.pluginId}] Tree transformer "${transformer.name}" failed: ${toErrorMessage(error)}`);
      }
    }

    return items;
  }

  resolvePluginAsset(pluginId, relativeAssetPath) {
    const plugin = this.pluginsById.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" was not found.`);
    }

    const normalizedRelativePath = String(relativeAssetPath || "")
      .split("/")
      .filter(Boolean)
      .join(path.sep);

    if (!normalizedRelativePath) {
      throw new Error("Plugin asset path is required.");
    }

    return ensurePathInsideDirectory(plugin.directory, path.join(plugin.directory, normalizedRelativePath), "asset path");
  }

  async readState() {
    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }

      this.logger.warn(`Failed to read plugin state file, falling back to defaults: ${toErrorMessage(error)}`);
      return {};
    }
  }

  async writeState() {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await fs.writeFile(this.stateFilePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async deactivatePlugins() {
    for (const lifecycle of this.activePluginLifecycles.slice().reverse()) {
      try {
        if (typeof lifecycle.cleanup === "function") {
          await lifecycle.cleanup();
        }

        if (typeof lifecycle.moduleDeactivate === "function") {
          await lifecycle.moduleDeactivate();
        }
      } catch (error) {
        this.logger.warn(`[plugin:${lifecycle.pluginId}] Deactivate failed: ${toErrorMessage(error)}`);
      }
    }

    this.activePluginLifecycles = [];
  }

  async discoverPlugins() {
    const directoryEntries = await fs.readdir(this.pluginsDirectory, { withFileTypes: true });
    const knownPluginIds = new Set();
    const discoveredPlugins = [];

    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isDirectory() || directoryEntry.name.startsWith(".")) {
        continue;
      }

      const discoveredPlugin = await this.readPluginManifest(directoryEntry.name);
      if (!discoveredPlugin) {
        continue;
      }

      if (discoveredPlugin.id && knownPluginIds.has(discoveredPlugin.id)) {
        discoveredPlugin.status = "invalid";
        discoveredPlugin.error = `Plugin id "${discoveredPlugin.id}" is duplicated.`;
        discoveredPlugin.enabled = false;
      }

      if (discoveredPlugin.id) {
        knownPluginIds.add(discoveredPlugin.id);
      }

      discoveredPlugins.push(discoveredPlugin);
    }

    return discoveredPlugins;
  }

  async readPluginManifest(directoryName) {
    const directory = path.join(this.pluginsDirectory, directoryName);
    const manifestPath = path.join(directory, MANIFEST_FILE_NAME);

    try {
      const rawManifest = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(rawManifest);
      return this.normalizePluginManifest({
        directoryName,
        directory,
        manifestPath,
        manifest,
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      return {
        id: directoryName,
        name: directoryName,
        version: "0.0.0",
        description: "",
        directoryName,
        directory,
        manifestPath,
        manifest: null,
        enabled: false,
        defaultEnabled: false,
        permissions: [],
        hooks: [],
        serverEntry: null,
        clientEntry: null,
        status: "invalid",
        error: `Invalid plugin manifest: ${toErrorMessage(error)}`,
      };
    }
  }

  normalizePluginManifest({ directoryName, directory, manifestPath, manifest }) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("Manifest must be a JSON object.");
    }

    const id = String(manifest.id || "").trim();
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new Error("Manifest field \"id\" must match /^[a-z0-9][a-z0-9-_]*$/.");
    }

    const name = String(manifest.name || "").trim();
    if (!name) {
      throw new Error("Manifest field \"name\" is required.");
    }

    const version = String(manifest.version || "").trim();
    if (!version) {
      throw new Error("Manifest field \"version\" is required.");
    }

    const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
    const permissions = Array.isArray(manifest.permissions)
      ? manifest.permissions.filter((permission) => typeof permission === "string" && permission.trim()).map((permission) => permission.trim())
      : [];
    const defaultEnabled = manifest.enabled !== false;
    const enabledOverride = this.state[id];
    const enabled = typeof enabledOverride?.enabled === "boolean" ? enabledOverride.enabled : defaultEnabled;

    return {
      id,
      name,
      version,
      description,
      directoryName,
      directory,
      manifestPath,
      manifest,
      enabled,
      defaultEnabled,
      permissions,
      hooks: [],
      serverEntry: normalizeRelativePluginFile(directory, manifest.serverEntry, "serverEntry"),
      clientEntry: normalizeRelativePluginFile(directory, manifest.clientEntry, "clientEntry"),
      status: enabled ? "loading" : "disabled",
      error: null,
    };
  }

  async activatePlugin(plugin) {
    try {
      if (plugin.serverEntry) {
        this.clearPluginRequireCache(plugin.directory);
        const pluginModule = require(plugin.serverEntry.absolutePath);
        const activate = pickLifecycleFunction(pluginModule, "activate");
        const moduleDeactivate = pickLifecycleFunction(pluginModule, "deactivate");
        const api = this.createPluginApi(plugin);
        let cleanup = null;

        if (activate) {
          const activateResult = await activate(api);
          if (typeof activateResult === "function") {
            cleanup = activateResult;
          } else if (typeof activateResult?.deactivate === "function") {
            cleanup = activateResult.deactivate;
          }
        }

        this.activePluginLifecycles.push({
          pluginId: plugin.id,
          cleanup,
          moduleDeactivate,
        });
      }

      if (plugin.clientEntry) {
        this.clientModules.push({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          url: this.buildPluginAssetUrl(plugin.id, plugin.clientEntry.relativePath),
        });
      }

      plugin.status = "enabled";
      plugin.error = null;
    } catch (error) {
      plugin.status = "error";
      plugin.error = toErrorMessage(error);
    }
  }

  createPluginApi(plugin) {
    return {
      id: plugin.id,
      version: plugin.version,
      getPluginDirectory: () => plugin.directory,
      getManifest: () => ({ ...plugin.manifest }),
      registerMarkdownTransformer: (name, handler) => {
        const registration = this.normalizeHookRegistration(name, handler, "markdown transformer");
        this.markdownTransformers.push({
          pluginId: plugin.id,
          name: registration.name,
          handler: registration.handler,
        });
        plugin.hooks.push(`markdown:${registration.name}`);
      },
      registerTreeTransformer: (name, handler) => {
        const registration = this.normalizeHookRegistration(name, handler, "tree transformer");
        this.treeTransformers.push({
          pluginId: plugin.id,
          name: registration.name,
          handler: registration.handler,
        });
        plugin.hooks.push(`tree:${registration.name}`);
      },
      log: (...messages) => {
        this.logger.log(`[plugin:${plugin.id}]`, ...messages);
      },
    };
  }

  normalizeHookRegistration(name, handler, label) {
    if (typeof name === "function") {
      return {
        name: "default",
        handler: name,
      };
    }

    if (typeof handler !== "function") {
      throw new Error(`A ${label} must provide a function handler.`);
    }

    return {
      name: typeof name === "string" && name.trim() ? name.trim() : "default",
      handler,
    };
  }

  buildPluginAssetUrl(pluginId, relativePath) {
    const encodedPluginId = encodeURIComponent(pluginId);
    const encodedPath = relativePath
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return `/plugin-assets/${encodedPluginId}/${encodedPath}?v=${this.runtimeVersion + 1}`;
  }

  clearPluginRequireCache(pluginDirectory) {
    const normalizedDirectory = path.resolve(pluginDirectory);
    const prefix = `${normalizedDirectory}${path.sep}`;

    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey === normalizedDirectory || cacheKey.startsWith(prefix)) {
        delete require.cache[cacheKey];
      }
    }
  }

  serializePlugin(plugin) {
    if (!plugin) {
      return null;
    }

    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      enabled: plugin.enabled,
      defaultEnabled: plugin.defaultEnabled,
      status: plugin.status,
      error: plugin.error,
      directory: plugin.directory,
      manifestPath: plugin.manifestPath,
      permissions: [...plugin.permissions],
      hooks: [...plugin.hooks],
      hasServerEntry: Boolean(plugin.serverEntry),
      hasClientEntry: Boolean(plugin.clientEntry),
      serverEntry: plugin.serverEntry?.relativePath || null,
      clientEntry: plugin.clientEntry?.relativePath || null,
    };
  }
}

module.exports = PluginManager;
