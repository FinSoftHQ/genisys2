#!/usr/bin/env tsx
/**
 * Scaffold a new Rivet agentOS + Pi workflow
 * 
 * Usage: npx tsx scaffold-workflow.ts --name my-agent --output ./my-agent
 */

import * as fs from "fs";
import * as path from "path";

interface Args {
  name: string;
  output: string;
  description?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Partial<Args> = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      result.name = args[i + 1];
      i++;
    } else if (args[i] === "--output" && i + 1 < args.length) {
      result.output = args[i + 1];
      i++;
    } else if (args[i] === "--description" && i + 1 < args.length) {
      result.description = args[i + 1];
      i++;
    }
  }
  
  if (!result.name || !result.output) {
    console.error("Usage: npx tsx scaffold-workflow.ts --name <name> --output <dir> [--description <desc>]");
    process.exit(1);
  }
  
  return result as Args;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, char) => char.toUpperCase())
    .replace(/^(.)/, (_, char) => char.toUpperCase());
}

function generateServerTemplate(name: string, description: string): string {
  const pascalName = toPascalCase(name);
  
  return `import { agentOs } from "rivetkit/agent-os";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import { actor, setup, workflow } from "rivetkit";

/**
 * ${description}
 */
const ${name} = actor({
  workflows: {
    execute: workflow<{ input: string }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("execute")) {
      const { input } = message.body;
      const agentHandle = c.actors.vm.getOrCreate([\`\${name}-\${Date.now()}\`]);

      // Step 1: Initialize workspace
      await c.step("init", async () => {
        await agentHandle.exec("mkdir -p /home/user/workspace");
        return { ready: true };
      });

      // Step 2: Execute Pi session
      await c.step("execute", async () => {
        const session = await agentHandle.createSession("pi", {
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        });
        
        try {
          await agentHandle.sendPrompt(
            session.sessionId,
            \`Task: \${input}\\n\\nWork in /home/user/workspace\`
          );
        } finally {
          await agentHandle.closeSession(session.sessionId);
        }
      });

      // Step 3: Retrieve results
      const result = await c.step("retrieve", async () => {
        try {
          const files = await agentHandle.exec("ls -la /home/user/workspace");
          return files.stdout;
        } catch {
          return "No output files";
        }
      });

      console.log("Workflow completed:", result);
      await message.complete();
    }
  },
});

const vm = agentOs({
  options: { software: [common, pi] },
});

export const registry = setup({
  use: { ${name}, vm },
});

registry.start();
`;
}

function generateClientTemplate(name: string): string {
  const pascalName = toPascalCase(name);
  
  return `import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>("http://localhost:6420");

async function main() {
  const handle = client.${name}.getOrCreate(["main"]);
  
  // Trigger the workflow
  await handle.send("execute", {
    input: process.argv[2] || "Write a hello world function",
  });
  
  console.log("Workflow triggered successfully");
}

main().catch(console.error);
`;
}

function generatePackageJson(name: string): string {
  return JSON.stringify({
    name: name,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx server.ts",
      client: "tsx client.ts",
    },
    dependencies: {
      "@rivet-dev/agent-os-common": "^0.1.0",
      "@rivet-dev/agent-os-pi": "^0.1.0",
      "rivetkit": "^2.2.0",
    },
    devDependencies: {
      "tsx": "^4.0.0",
      "typescript": "^5.0.0",
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
  }, null, 2);
}

function generateReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Setup

1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

2. Set your Anthropic API key:
   \`\`\`bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   \`\`\`

3. Start the server:
   \`\`\`bash
   npm start
   \`\`\`

4. In another terminal, trigger the workflow:
   \`\`\`bash
   npm run client "Your task here"
   \`\`\`

## Project Structure

- \`server.ts\` - Rivet actor with Pi workflow
- \`client.ts\` - Client to trigger workflows
- \`package.json\` - Dependencies

## Customization

Edit the \`execute\` step in \`server.ts\` to customize the Pi prompt and behavior.
`;
}

function main() {
  const args = parseArgs();
  const outputDir = path.resolve(args.output);
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Generate files
  const description = args.description || `A Rivet agentOS + Pi workflow`;
  
  fs.writeFileSync(
    path.join(outputDir, "server.ts"),
    generateServerTemplate(args.name, description)
  );
  
  fs.writeFileSync(
    path.join(outputDir, "client.ts"),
    generateClientTemplate(args.name)
  );
  
  fs.writeFileSync(
    path.join(outputDir, "package.json"),
    generatePackageJson(args.name)
  );
  
  fs.writeFileSync(
    path.join(outputDir, "tsconfig.json"),
    generateTsConfig()
  );
  
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    generateReadme(args.name, description)
  );
  
  console.log(`✅ Scaffolded ${args.name} at ${outputDir}`);
  console.log("\nNext steps:");
  console.log(`  cd ${args.output}`);
  console.log("  npm install");
  console.log("  export ANTHROPIC_API_KEY=...");
  console.log("  npm start");
}

main();
