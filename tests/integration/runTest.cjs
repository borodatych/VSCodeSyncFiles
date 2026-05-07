const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(extensionDevelopmentPath, "dist", "test", "suite", "index.js");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
