const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { marked } = require("marked");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

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
  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
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

  return normalizedEntries;
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

  return {
    name: path.basename(filePath),
    path: path.relative(workspace.realPath, filePath).split(path.sep).join("/"),
    raw,
    html,
  };
}

async function serveStaticFile(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  const publicPrefix = `${PUBLIC_DIR}${path.sep}`;

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    sendText(response, 403, "Forbidden");
    return;
  }

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

    sendText(response, 500, "Failed to read static file.");
  }
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

    sendJson(response, 404, { error: "API endpoint not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    sendJson(response, 400, { error: message });
  }
}

async function bootstrap() {
  await initializeWorkspaceRoot(process.cwd());

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, url);
      return;
    }

    await serveStaticFile(url.pathname, response);
  });

  server.listen(PORT, HOST, () => {
    console.log(`MD Reader running at http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
