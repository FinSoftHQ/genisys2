import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { complete } from '@mariozechner/pi-ai';
import { Type } from '@mariozechner/pi-ai';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@mariozechner/pi-ai';

const FILE_TRUNCATE_CHARS = Number(process.env.LLM_TOOL_LOOP_FILE_TRUNCATE_CHARS ?? '8000');

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file from the workspace to inspect its contents. ' +
    'Use this when you need to verify file contents, line ranges, or implementation details before producing your final answer. ' +
    'Every file you read costs tokens. Only read files where you cannot determine correct answers from the context already provided. ' +
    'For large files, use offset and limit to read specific portions rather than the entire file.',
  parameters: Type.Object({
    path: Type.String({
      description: 'Relative path from the workspace root',
    }),
    offset: Type.Number({
      description: 'Byte offset to start reading from (0-based). Use this to read large files in chunks.',
      default: 0,
    }),
    limit: Type.Number({
      description: 'Maximum number of bytes to read. Use this to limit the amount of content returned.',
      default: 8000,
    }),
  }),
};

export const writeToFileTool: Tool = {
  name: 'write_to_file',
  description:
    'Write content to a file in the workspace. ' +
    'Use this when you need to output structured data (e.g., JSON) or save generated artifacts to disk.',
  parameters: Type.Object({
    path: Type.String({ description: 'Relative path from the workspace root' }),
    content: Type.String({ description: 'Full content to write to the file' }),
  }),
};

export interface ToolLoopOptions<TApi extends Api = Api> {
  model: Model<TApi>;
  apiKey: string;
  systemPrompt?: string;
  userMessage: string;
  workingDir?: string;
  tools?: Tool[];
  maxRounds?: number;
  maxFilesPerRound?: number;
  fileTruncateChars?: number;
  maxTokens?: number;
}

export interface ToolLoopResult {
  text: string;
  stopReason: string;
  usage: AssistantMessage['usage'];
  totalRounds: number;
  capturedWrites: Record<string, string>;
}

function buildWorkspacePreamble(workingDir: string): string {
  return `[SYSTEM WORKING DIRECTORY] Your current working directory is: ${workingDir}
This directory IS your project root. All code, tests, and files you create must be written relative to this directory.
All relative paths in read, write, and edit operations are resolved from this directory.
When running tests, use explicit file paths (e.g. vitest run src/apps/api/path/to/file.test.ts).
process.cwd() inside this environment will return the path shown above.
This workspace is a git clone of the project. If body text or instructions mention absolute paths from the original repository, treat them as relative to this workspace directory.
Do not change directory or write files outside this directory unless explicitly instructed.

`;
}

function truncateFileContent(name: string, content: string, limit: number): string {
  if (content.length <= limit) {
    return content;
  }
  const omitted = content.length - limit;
  return `${content.slice(0, limit)}\n\n[TRUNCATED ${omitted} characters from ${name}]`;
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

/* ------------------------------------------------------------------ */
/*  DSML fallback parser                                               */
/* ------------------------------------------------------------------ */

function extractDsmlToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // Match DSML invoke blocks. The ｜ character is U+FF5C (fullwidth vertical line).
  const invokeRegex = /<\|\|DSML\|\|invoke\s+name="([^"]+)">([\s\S]*?)<\|\|\/DSML\|\|invoke>/g;
  let match: RegExpExecArray | null;
  while ((match = invokeRegex.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const args: Record<string, unknown> = {};
    const paramRegex = /<\|parameter\s+name="([^"]+)"\|\|>([\s\S]*?)<\|\/parameter\|\|>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2];
      try {
        args[paramName] = JSON.parse(paramValue);
      } catch {
        args[paramName] = paramValue;
      }
    }
    calls.push({
      type: 'toolCall',
      id: `dsml-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      name,
      arguments: args,
    });
  }
  return calls;
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

export async function runLlmWithToolLoop<TApi extends Api>(
  options: ToolLoopOptions<TApi>,
): Promise<ToolLoopResult> {
  const {
    model,
    apiKey,
    systemPrompt,
    userMessage,
    workingDir,
    tools = [],
    maxRounds = 3,
    maxFilesPerRound = 7,
    fileTruncateChars = FILE_TRUNCATE_CHARS,
  } = options;

  const effectiveSystemPrompt = workingDir
    ? buildWorkspacePreamble(workingDir) + (systemPrompt ?? '')
    : systemPrompt;

  const messages: Message[] = [
    { role: 'user', content: userMessage, timestamp: Date.now() },
  ];

  let totalRounds = 0;
  const capturedWrites: Record<string, string> = {};

  for (let round = 0; round < maxRounds; round++) {
    totalRounds = round + 1;
    console.log(`[llm-tool-loop] Round ${totalRounds}/${maxRounds} starting…`);

    const context: {
      systemPrompt?: string;
      messages: Message[];
      tools?: Tool[];
    } = {
      messages,
    };

    if (effectiveSystemPrompt && effectiveSystemPrompt.trim().length > 0) {
      context.systemPrompt = effectiveSystemPrompt;
    }

    if (tools.length > 0) {
      context.tools = tools;
    }

    const response = await complete(model, context, { apiKey, maxTokens: options.maxTokens });

    if (response.stopReason === 'error') {
      const text = response.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return { text, stopReason: 'error', usage: response.usage, totalRounds, capturedWrites };
    }

    let toolCalls = response.content.filter((c): c is ToolCall => c.type === 'toolCall');

    // Fallback: if no native tool calls but text contains DSML, parse it
    if (toolCalls.length === 0) {
      const textContent = response.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (textContent.includes('<||DSML||invoke')) {
        const dsmlCalls = extractDsmlToolCalls(textContent);
        if (dsmlCalls.length > 0) {
          toolCalls = dsmlCalls;
          // Replace the assistant message content so downstream logic sees tool calls
          response.content = response.content
            .filter((c) => c.type !== 'text')
            .concat(toolCalls);
        }
      }
    }

    // No tool calls — we have the final answer
    if (toolCalls.length === 0) {
      const text = response.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      console.log(`[llm-tool-loop] Round ${totalRounds} completed with final answer (stopReason=${response.stopReason})`);
      return { text, stopReason: response.stopReason, usage: response.usage, totalRounds, capturedWrites };
    }

    console.log(`[llm-tool-loop] Round ${totalRounds}: ${toolCalls.length} tool call(s) requested`);

    // Limit files per round
    const limitedCalls = toolCalls.slice(0, maxFilesPerRound);
    if (toolCalls.length > maxFilesPerRound) {
      console.warn(
        `[llm-tool-loop] Round ${round + 1}: ${toolCalls.length} tool calls requested, limiting to ${maxFilesPerRound}`,
      );
    }

    // Append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content,
      api: response.api,
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      stopReason: response.stopReason,
      timestamp: Date.now(),
    });

    // Execute tool calls in parallel
    const toolResults = await Promise.all(
      limitedCalls.map(async (call): Promise<ToolResultMessage> => {
        console.log(`[llm-tool-loop] Executing ${call.name}(${JSON.stringify(call.arguments)}) workingDir=${workingDir ?? '<none>'}`);

        if (call.name === 'read_file') {
          if (!workingDir) {
            const errorText = 'Error: No working directory is configured. You cannot read files.';
            console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${errorText}"`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: 'text',
                  text: errorText,
                },
              ],
              isError: true,
              timestamp: Date.now(),
            };
          }

          const relativePath = typeof call.arguments.path === 'string' ? call.arguments.path : '';
          const absolutePath = join(workingDir, relativePath);

          if (!isWithinDirectory(workingDir, absolutePath)) {
            const errorText = `Error: Path traversal blocked. "${relativePath}" resolves outside the workspace.`;
            console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${errorText}"`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: 'text',
                  text: errorText,
                },
              ],
              isError: true,
              timestamp: Date.now(),
            };
          }

          try {
            const fullContent = await readFile(absolutePath, 'utf8');
            const offset = typeof call.arguments.offset === 'number' ? Math.max(0, call.arguments.offset) : 0;
            const limit = typeof call.arguments.limit === 'number' ? Math.max(1, call.arguments.limit) : fileTruncateChars;
            const slicedContent = fullContent.slice(offset, offset + limit);
            const headerLine = `[Showing bytes ${offset}–${offset + slicedContent.length} of ${fullContent.length} total]`;
            const contentWithHeader = slicedContent.length < fullContent.length
              ? `${headerLine}\n\n${slicedContent}\n\n[${fullContent.length - slicedContent.length - offset} more bytes available — use offset=${offset + slicedContent.length} to continue reading]`
              : `${headerLine}\n\n${slicedContent}`;
            const truncated = truncateFileContent(relativePath, contentWithHeader, fileTruncateChars);
            console.log(`[llm-tool-loop] ${call.name} result: success=true, chars=${truncated.length}, file=${relativePath}, offset=${offset}, limit=${limit}`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: truncated }],
              isError: false,
              timestamp: Date.now(),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${message}"`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: `Error reading file: ${message}` }],
              isError: true,
              timestamp: Date.now(),
            };
          }
        }

        if (call.name === 'write_to_file') {
          if (!workingDir) {
            const errorText = 'Error: No working directory is configured. You cannot write files.';
            console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${errorText}"`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: 'text',
                  text: errorText,
                },
              ],
              isError: true,
              timestamp: Date.now(),
            };
          }

          const relativePath = typeof call.arguments.path === 'string' ? call.arguments.path : '';
          const absolutePath = join(workingDir, relativePath);

          if (!isWithinDirectory(workingDir, absolutePath)) {
            const errorText = `Error: Path traversal blocked. "${relativePath}" resolves outside the workspace.`;
            console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${errorText}"`);
            return {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: 'text',
                  text: errorText,
                },
              ],
              isError: true,
              timestamp: Date.now(),
            };
          }

          const content = typeof call.arguments.content === 'string' ? call.arguments.content : '';
          capturedWrites[relativePath] = content;
          console.log(`[llm-tool-loop] ${call.name} result: success=true, chars=${content.length}, file=${relativePath}`);

          return {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: 'text',
                text: `Captured ${content.length} characters for "${relativePath}" (not written to disk).`,
              },
            ],
            isError: false,
            timestamp: Date.now(),
          };
        }

        const errorText = `Error: Unknown tool "${call.name}". Available tools: read_file, write_to_file.`;
        console.log(`[llm-tool-loop] ${call.name} result: success=false, error="${errorText}"`);
        return {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
          isError: true,
          timestamp: Date.now(),
        };
      }),
    );

    messages.push(...toolResults);
  }

  // Max rounds reached — force final answer without tools
  totalRounds++;
  console.warn(`[llm-tool-loop] Max rounds (${maxRounds}) reached. Forcing final answer without tools (round ${totalRounds}).`);

  // Append a strong instruction so the LLM knows it must output its final answer now
  messages.push({
    role: 'user',
    content: 'You have used all available tool rounds. STOP requesting tools. Output your final answer now.',
    timestamp: Date.now(),
  });

  const finalContext: { systemPrompt?: string; messages: Message[] } = { messages };
  if (effectiveSystemPrompt && effectiveSystemPrompt.trim().length > 0) {
    finalContext.systemPrompt = effectiveSystemPrompt;
  }

  const finalResponse = await complete(model, finalContext, { apiKey, maxTokens: options.maxTokens });

  const text = finalResponse.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');

  console.log(`[llm-tool-loop] Round ${totalRounds} completed with forced final answer (stopReason=${finalResponse.stopReason})`);
  return { text, stopReason: finalResponse.stopReason, usage: finalResponse.usage, totalRounds, capturedWrites };
}
