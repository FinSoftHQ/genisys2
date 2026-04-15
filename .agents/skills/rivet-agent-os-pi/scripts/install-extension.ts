#!/usr/bin/env tsx
/**
 * Install a Pi extension in a Rivet VM
 * 
 * Usage: npx tsx install-extension.ts --file ./my-extension.js --vm-id my-vm
 */

import * as fs from "fs";
import * as path from "path";

interface Args {
  file: string;
  vmId: string;
  global?: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Partial<Args> = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      result.file = args[i + 1];
      i++;
    } else if (args[i] === "--vm-id" && i + 1 < args.length) {
      result.vmId = args[i + 1];
      i++;
    } else if (args[i] === "--global") {
      result.global = true;
    }
  }
  
  if (!result.file || !result.vmId) {
    console.error("Usage: npx tsx install-extension.ts --file <extension.js> --vm-id <id> [--global]");
    console.error("");
    console.error("Options:");
    console.error("  --file      Path to the extension .js file");
    console.error("  --vm-id     Rivet VM identifier");
    console.error("  --global    Install to global extensions dir (~/.pi/agent/extensions/)");
    console.error("              Default: project-local (<cwd>/.pi/extensions/)");
    process.exit(1);
  }
  
  return result as Args;
}

function generateInstallCode(extensionPath: string, vmId: string, isGlobal: boolean): string {
  const extDir = isGlobal 
    ? `/home/user/.pi/agent/extensions`
    : `/home/user/workspace/.pi/extensions`;
  
  const extName = path.basename(extensionPath);
  
  return `import { createClient } from "rivetkit/client";
import type { registry } from "./server";

/**
 * Install Pi extension in Rivet VM
 * 
 * Run this after your server is running but before creating Pi sessions.
 */

const client = createClient<typeof registry>("http://localhost:6420");

async function installExtension() {
  const vm = client.vm.getOrCreate(["${vmId}"]);
  
  // Read extension code
  const extensionCode = \`${fs.readFileSync(extensionPath, 'utf-8').replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`;
  
  // Create extensions directory
  await vm.mkdir("${extDir}", { recursive: true });
  
  // Write extension file
  await vm.writeFile("${extDir}/${extName}", extensionCode);
  
  console.log("✅ Extension installed to ${extDir}/${extName}");
  console.log("   Pi will discover it automatically on next session creation");
}

installExtension().catch(console.error);
`;
}

function main() {
  const args = parseArgs();
  
  if (!fs.existsSync(args.file)) {
    console.error(`Error: Extension file not found: ${args.file}`);
    process.exit(1);
  }
  
  const installScript = generateInstallCode(args.file, args.vmId, args.global ?? false);
  const outputFile = `install-ext-${path.basename(args.file, '.js')}.ts`;
  
  fs.writeFileSync(outputFile, installScript);
  
  console.log(`✅ Generated ${outputFile}`);
  console.log("\nUsage:");
  console.log("  1. Ensure your Rivet server is running");
  console.log(`  2. Run: npx tsx ${outputFile}`);
  console.log("  3. Create Pi sessions - the extension will be auto-discovered");
}

main();
