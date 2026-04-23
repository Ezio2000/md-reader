const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { marked } = require("marked");
const PluginManager = require("./lib/plugin-manager");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIRECTORY = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIRECTORY, "public");
const AI_SUMMARY_BASE_URL = String(process.env.MD_READER_AI_SUMMARY_BASE_URL || "").trim().replace(/\/+$/, "");
const AI_SUMMARY_UPSTREAM_ID = (process.env.MD_READER_AI_SUMMARY_UPSTREAM_ID || "kimi").trim() || "kimi";
const AI_SUMMARY_MODEL = (process.env.MD_READER_AI_SUMMARY_MODEL || "kimi-for-coding").trim() || "kimi-for-coding";
const AI_SUMMARY_MAX_CHARS = Math.max(4000, Number(process.env.MD_READER_AI_SUMMARY_MAX_CHARS || 40000));
const AI_SUMMARY_TIMEOUT_MS = Math.max(5000, Number(process.env.MD_READER_AI_SUMMARY_TIMEOUT_MS || 60000));
const pluginManager = new PluginManager({
  rootDirectory: ROOT_DIRECTORY,
  logger: console,
});

let workspaceRoot = "";
let workspaceRootRealPath = "";

marked.setOptions({
  gfm: true,
  breaks: true,
});

async function initializeWorkspaceRoot(rootPath) {
  const realPath = await fs.realpath(rootPath);
  const stats = await fs.stat(realPath);

  if (!stats.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }

  workspaceRoot = realPath;
  workspaceRootRealPath = realPath;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function openMacOSDirectoryPicker() {
  const script = `
    try
      POSIX path of (choose folder with prompt "Select Markdown workspace")
    on error number -128
      return ""
    end try
  `;
  const result = await runCommand("osascript", ["-e", script]);

  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to open the macOS folder picker.");
  }

  return result.stdout || null;
}

async function openWindowsDirectoryPicker() {
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select Markdown workspace'
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write($dialog.SelectedPath)
    }
  `;
  const result = await runCommand("powershell", ["-NoProfile", "-Command", script]);

  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to open the Windows folder picker.");
  }

  return result.stdout || null;
}

async function openLinuxDirectoryPicker() {
  try {
    const zenityResult = await runCommand("zenity", [
      "--file-selection",
      "--directory",
      "--title=Select Markdown workspace",
    ]);

    if (zenityResult.code === 0) {
      return zenityResult.stdout || null;
    }

    if (zenityResult.code === 1) {
      return null;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const kdialogResult = await runCommand("kdialog", ["--getexistingdirectory", ".", "Select Markdown workspace"]);

    if (kdialogResult.code === 0) {
      return kdialogResult.stdout || null;
    }

    if (kdialogResult.code === 1) {
      return null;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  throw new Error("No native folder picker is available on this Linux system. Install zenity or kdialog.");
}

async function openSystemDirectoryPicker() {
  if (process.env.MD_READER_PICKER_PATH) {
    return process.env.MD_READER_PICKER_PATH;
  }

  if (process.platform === "darwin") {
    return openMacOSDirectoryPicker();
  }

  if (process.platform === "win32") {
    return openWindowsDirectoryPicker();
  }

  if (process.platform === "linux") {
    return openLinuxDirectoryPicker();
  }

  throw new Error(`Native folder picker is not supported on ${process.platform}.`);
}

function getWorkspaceSnapshot() {
  if (!workspaceRootRealPath) {
    throw new Error("Workspace is not configured.");
  }

  return {
    rootPath: workspaceRoot,
    realPath: workspaceRootRealPath,
  };
}

async function getWorkspacePayload(workspace = getWorkspaceSnapshot()) {
  return {
    rootPath: workspace.rootPath,
    items: await listWorkspaceChildren("", workspace),
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js" || extension === ".mjs") {
    return "application/javascript; charset=utf-8";
  }

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}

function shouldIgnoreDirectoryName(directoryName) {
  return directoryName === "node_modules" || directoryName.startsWith(".");
}

async function resolveWorkspaceEntry(relativePath = "", workspace = getWorkspaceSnapshot()) {
  const candidatePath = path.resolve(workspace.realPath, relativePath || ".");
  const realPath = await fs.realpath(candidatePath);
  const rootPrefix = `${workspace.realPath}${path.sep}`;

  if (realPath !== workspace.realPath && !realPath.startsWith(rootPrefix)) {
    throw new Error("Path is outside of the workspace.");
  }

  return realPath;
}

async function directoryHasVisibleChildren(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory() && shouldIgnoreDirectoryName(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      return true;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
      return true;
    }
  }

  return false;
}

async function listWorkspaceChildren(relativePath = "", workspace = getWorkspaceSnapshot()) {
  const directoryPath = await resolveWorkspaceEntry(relativePath, workspace);
  const stats = await fs.stat(directoryPath);

  if (!stats.isDirectory()) {
    throw new Error("Target path is not a directory.");
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const visibleEntries = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) {
        return null;
      }

      if (entry.isDirectory() && shouldIgnoreDirectoryName(entry.name)) {
        return null;
      }

      if (!entry.isDirectory() && !entry.isFile()) {
        return null;
      }

      const entryExtension = path.extname(entry.name).toLowerCase();
      if (entry.isFile() && entryExtension !== ".md") {
        return null;
      }

      const absoluteChildPath = path.join(directoryPath, entry.name);
      const childRelativePath = path
        .relative(workspace.realPath, absoluteChildPath)
        .split(path.sep)
        .join("/");
      const hasChildren = entry.isDirectory() ? await directoryHasVisibleChildren(absoluteChildPath) : false;

      if (entry.isDirectory() && !hasChildren) {
        return null;
      }

      return {
        name: entry.name,
        path: childRelativePath,
        type: entry.isDirectory() ? "directory" : "file",
        hasChildren,
      };
    })
  );

  const normalizedEntries = visibleEntries.filter(Boolean);
  normalizedEntries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });

  return pluginManager.applyTreeTransformers({
    items: normalizedEntries,
    relativePath,
    workspaceRoot: workspace.rootPath,
  });
}

async function readMarkdownFile(relativePath) {
  const workspace = getWorkspaceSnapshot();
  const filePath = await resolveWorkspaceEntry(relativePath, workspace);
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Target path is not a file.");
  }

  if (path.extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Only .md files can be opened.");
  }

  const raw = await fs.readFile(filePath, "utf8");
  const html = marked.parse(raw);
  const transformed = await pluginManager.applyMarkdownTransformers({
    raw,
    html,
    relativePath,
    absolutePath: filePath,
    workspaceRoot: workspace.rootPath,
    meta: {},
  });

  return {
    name: path.basename(filePath),
    path: path.relative(workspace.realPath, filePath).split(path.sep).join("/"),
    raw: transformed.raw,
    html: transformed.html,
    pluginMeta: transformed.meta,
  };
}

async function readMarkdownSource(relativePath) {
  const workspace = getWorkspaceSnapshot();
  const filePath = await resolveWorkspaceEntry(relativePath, workspace);
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Target path is not a file.");
  }

  if (path.extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Only .md files can be summarized.");
  }

  const raw = await fs.readFile(filePath, "utf8");
  return {
    name: path.basename(filePath),
    path: path.relative(workspace.realPath, filePath).split(path.sep).join("/"),
    raw,
  };
}

function clipTextByChars(value, maxChars) {
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
    };
  }

  return {
    text: value.slice(0, maxChars),
    truncated: true,
  };
}

function extractAnthropicTextContent(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const parts = [];

  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }

  return parts.join("\n\n").trim();
}

async function generateAiSummary(relativePath) {
  const markdown = await readMarkdownSource(relativePath);
  const clipped = clipTextByChars(markdown.raw, AI_SUMMARY_MAX_CHARS);
  const prompt = [
    "请用中文为下面的 Markdown 文档生成简洁摘要。",
    "输出格式要求：",
    "1. 先给一段一句话总览。",
    "2. 再给 3 到 6 条要点。",
    "3. 如果文中包含风险、待办或结论，单独补一段。",
    "4. 不要编造原文没有的信息。",
    "",
    `文件名：${markdown.name}`,
    clipped.truncated ? `提示：正文过长，以下内容已截断到前 ${AI_SUMMARY_MAX_CHARS} 个字符。` : "提示：以下是完整正文。",
    "",
    markdown.raw.length ? clipped.text : "(空文档)",
  ].join("\n");

  if (!AI_SUMMARY_BASE_URL) {
    throw new Error("MD_READER_AI_SUMMARY_BASE_URL is required.");
  }

  const response = await fetch(`${AI_SUMMARY_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upstream-Id": AI_SUMMARY_UPSTREAM_ID,
    },
    body: JSON.stringify({
      model: AI_SUMMARY_MODEL,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(AI_SUMMARY_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error || payload?.message || `Summary request failed with status ${response.status}.`;
    throw new Error(message);
  }

  const summary = extractAnthropicTextContent(payload);
  if (!summary) {
    throw new Error("AI summary returned no text.");
  }

  return {
    path: markdown.path,
    name: markdown.name,
    summary,
    model: payload?.model || AI_SUMMARY_MODEL,
    truncated: clipped.truncated,
  };
}

async function serveFile(response, filePath) {
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": content.byteLength,
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }

    sendText(response, 500, "Failed to read file.");
  }
}

async function serveStaticFile(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  const publicPrefix = `${PUBLIC_DIR}${path.sep}`;

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  await serveFile(response, filePath);
}

async function servePluginAsset(requestPath, response) {
  const prefix = "/plugin-assets/";
  const assetPath = requestPath.slice(prefix.length);
  const [encodedPluginId, ...encodedSegments] = assetPath.split("/").filter(Boolean);

  if (!encodedPluginId || encodedSegments.length === 0) {
    sendText(response, 404, "Plugin asset not found");
    return;
  }

  const pluginId = decodeURIComponent(encodedPluginId);
  const relativeAssetPath = encodedSegments.map((segment) => decodeURIComponent(segment)).join("/");
  const filePath = pluginManager.resolvePluginAsset(pluginId, relativeAssetPath);
  await serveFile(response, filePath);
}

async function parseJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApiRequest(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      sendJson(response, 200, await getWorkspacePayload(getWorkspaceSnapshot()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace") {
      const body = await parseJsonBody(request);
      const nextRoot = String(body.rootPath || "").trim();

      if (!nextRoot) {
        sendJson(response, 400, { error: "Workspace path is required." });
        return;
      }

      await initializeWorkspaceRoot(nextRoot);
      sendJson(response, 200, await getWorkspacePayload(getWorkspaceSnapshot()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/system-directory-picker") {
      const nextRoot = await openSystemDirectoryPicker();

      if (!nextRoot) {
        sendJson(response, 200, {
          cancelled: true,
          rootPath: workspaceRoot,
        });
        return;
      }

      await initializeWorkspaceRoot(nextRoot);
      sendJson(response, 200, {
        cancelled: false,
        ...(await getWorkspacePayload(getWorkspaceSnapshot())),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tree") {
      const relativePath = url.searchParams.get("path") || "";
      const workspace = getWorkspaceSnapshot();
      sendJson(response, 200, {
        path: relativePath,
        items: await listWorkspaceChildren(relativePath, workspace),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/file") {
      const relativePath = url.searchParams.get("path") || "";

      if (!relativePath) {
        sendJson(response, 400, { error: "Markdown path is required." });
        return;
      }

      sendJson(response, 200, await readMarkdownFile(relativePath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai-summary") {
      const body = await parseJsonBody(request);
      const relativePath = String(body.path || "").trim();

      if (!relativePath) {
        sendJson(response, 400, { error: "Markdown path is required." });
        return;
      }

      sendJson(response, 200, await generateAiSummary(relativePath));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/plugins") {
      sendJson(response, 200, pluginManager.getManagementPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/plugins/runtime") {
      sendJson(response, 200, pluginManager.getClientRuntimePayload());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/plugins/reload") {
      sendJson(response, 200, await pluginManager.reload());
      return;
    }

    const pluginStateMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/state$/);
    if (request.method === "POST" && pluginStateMatch) {
      const pluginId = decodeURIComponent(pluginStateMatch[1]);
      const body = await parseJsonBody(request);

      if (typeof body.enabled !== "boolean") {
        sendJson(response, 400, { error: "Plugin state payload must contain a boolean \"enabled\" field." });
        return;
      }

      const plugin = await pluginManager.setPluginEnabled(pluginId, body.enabled);
      sendJson(response, 200, {
        plugin,
        runtime: pluginManager.getClientRuntimePayload(),
      });
      return;
    }

    sendJson(response, 404, { error: "API endpoint not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    sendJson(response, 400, { error: message });
  }
}

async function bootstrap() {
  await initializeWorkspaceRoot(process.cwd());
  await pluginManager.initialize();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

      if (url.pathname.startsWith("/api/")) {
        await handleApiRequest(request, response, url);
        return;
      }

      if (url.pathname.startsWith("/plugin-assets/")) {
        await servePluginAsset(url.pathname, response);
        return;
      }

      await serveStaticFile(url.pathname, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      sendText(response, 400, message);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`MD Reader running at http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
