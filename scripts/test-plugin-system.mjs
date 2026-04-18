import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const testPort = 3101;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer(url, timeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // Keep polling until the timeout is reached.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  throw new Error(`Timed out waiting for ${url}`);
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
    throw new Error(payload.error || `Request failed for ${url}`);
  }

  return payload;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "md-reader-plugin-test-"));
  const workspaceDirectory = path.join(tempRoot, "workspace");
  const pluginDirectory = path.join(tempRoot, "plugins");
  const stateDirectory = path.join(tempRoot, "state");
  const pluginRoot = path.join(pluginDirectory, "runtime-check");
  let server;

  try {
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(path.join(workspaceDirectory, "test.md"), "# Plugin Test\n\nHello plugin.\n", "utf8");
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      `${JSON.stringify(
        {
          id: "runtime-check",
          name: "Runtime Check",
          version: "0.1.0",
          description: "Temporary integration test plugin.",
          serverEntry: "server.js",
          clientEntry: "client.js",
          permissions: ["markdown:transform", "tree:transform", "ui:preview"],
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(pluginRoot, "server.js"),
      `
module.exports.activate = function activate(api) {
  api.registerMarkdownTransformer("badge", async ({ html }) => {
    return {
      html: html + '<p data-plugin="runtime-check">plugin-active</p>',
      meta: {
        runtimeCheck: true
      }
    };
  });

  api.registerTreeTransformer("root-tag", async ({ items, relativePath }) => {
    if (relativePath !== "") {
      return { items };
    }

    return {
      items: items.map((item) => ({
        ...item,
        tag: "checked"
      }))
    };
  });
};
`.trimStart(),
      "utf8"
    );
    await writeFile(
      path.join(pluginRoot, "client.js"),
      `
export async function activate(api) {
  api.onPreviewRendered(async ({ previewElement }) => {
    previewElement.dataset.clientPlugin = "runtime-check";
  });
}
`.trimStart(),
      "utf8"
    );

    server = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(testPort),
        MD_READER_PICKER_PATH: workspaceDirectory,
        MD_READER_PLUGIN_DIR: pluginDirectory,
        MD_READER_STATE_DIR: stateDirectory,
      },
      stdio: "pipe",
    });

    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");

    await waitForServer(`http://127.0.0.1:${testPort}/api/workspace`);
    await fetchJson(`http://127.0.0.1:${testPort}/api/workspace`, {
      method: "POST",
      body: JSON.stringify({
        rootPath: workspaceDirectory,
      }),
    });

    const pluginsPayload = await fetchJson(`http://127.0.0.1:${testPort}/api/plugins`);
    assert(pluginsPayload.items.length === 1, "Expected exactly one plugin to be discovered.");
    assert(pluginsPayload.items[0].status === "enabled", "Expected test plugin to be enabled.");
    assert(pluginsPayload.items[0].hooks.includes("markdown:badge"), "Expected markdown hook to be registered.");
    assert(pluginsPayload.items[0].hooks.includes("tree:root-tag"), "Expected tree hook to be registered.");

    const workspacePayload = await fetchJson(`http://127.0.0.1:${testPort}/api/workspace`);
    assert(workspacePayload.items[0].tag === "checked", "Expected tree transformer output to appear in workspace payload.");

    const runtimePayload = await fetchJson(`http://127.0.0.1:${testPort}/api/plugins/runtime`);
    assert(runtimePayload.modules.length === 1, "Expected one client runtime module.");
    const runtimeModuleResponse = await fetch(`http://127.0.0.1:${testPort}${runtimePayload.modules[0].url}`);
    assert(runtimeModuleResponse.ok, "Expected client module asset to be served.");

    const markdownPayload = await fetchJson(`http://127.0.0.1:${testPort}/api/file?path=test.md`);
    assert(markdownPayload.html.includes('data-plugin="runtime-check"'), "Expected markdown transformer to modify preview HTML.");
    assert(markdownPayload.pluginMeta.runtimeCheck === true, "Expected markdown transformer metadata to be returned.");

    await fetchJson(`http://127.0.0.1:${testPort}/api/plugins/runtime-check/state`, {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });

    const disabledPayload = await fetchJson(`http://127.0.0.1:${testPort}/api/file?path=test.md`);
    assert(!disabledPayload.html.includes('data-plugin="runtime-check"'), "Expected plugin output to disappear after disabling.");

    const pluginsPage = await fetch(`http://127.0.0.1:${testPort}/plugins.html`);
    const pluginsPageHtml = await pluginsPage.text();
    assert(pluginsPage.ok, "Expected plugin management page to be served.");
    assert(pluginsPageHtml.includes("插件管理页面"), "Expected plugin management page HTML to include the page title.");

    const persistedState = JSON.parse(await readFile(path.join(stateDirectory, "plugins-state.json"), "utf8"));
    assert(persistedState["runtime-check"].enabled === false, "Expected plugin state file to persist the disabled status.");

    console.log("Plugin system integration test passed.");
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => {
        server.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
