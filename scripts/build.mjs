import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });

    child.on("error", reject);
  });
}

async function createDistPackageJson() {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  const distPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    description: packageJson.description,
    main: "server.js",
    type: packageJson.type,
    scripts: {
      start: "node server.js",
    },
    dependencies: packageJson.dependencies,
  };

  await writeFile(path.join(distDir, "package.json"), `${JSON.stringify(distPackageJson, null, 2)}\n`, "utf8");
}

async function main() {
  console.log("Checking source files...");
  await run(process.execPath, ["--check", "server.js"]);
  await run(process.execPath, ["--check", "public/app.js"]);

  console.log("Preparing dist directory...");
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  console.log("Copying runtime files...");
  await cp(path.join(rootDir, "lib"), path.join(distDir, "lib"), { recursive: true });
  await cp(path.join(rootDir, "server.js"), path.join(distDir, "server.js"));
  await cp(path.join(rootDir, "plugins"), path.join(distDir, "plugins"), { recursive: true });
  await cp(path.join(rootDir, "public"), path.join(distDir, "public"), { recursive: true });
  await cp(path.join(rootDir, "package-lock.json"), path.join(distDir, "package-lock.json"));
  await cp(path.join(rootDir, "README.md"), path.join(distDir, "README.md"));
  await createDistPackageJson();

  console.log(`Build complete: ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
