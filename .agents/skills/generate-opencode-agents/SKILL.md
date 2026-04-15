---
name: generate-opencode-agents
description: |
  Generate OpenCode agent configuration files in Markdown format based on user-provided agent descriptions, roles, and workflow protocols. This skill transforms plain-text descriptions of AI team members into properly formatted OpenCode agent files. ALWAYS use this skill whenever the user mentions creating OpenCode agents, setting up an AI team, generating agent configurations, or when they describe agent roles and workflows that need to be formalized as .md files. This includes mentions of "agent team", "AI workforce", "autonomous agents", or when the user lists roles like "architect", "developer", "reviewer", etc. that should become OpenCode agents. Even if the user doesn't explicitly say "create agent files", if they're describing a multi-agent workflow or team structure, invoke this skill immediately.
---

# Generate OpenCode Agents

This skill helps you automatically generate OpenCode agent configuration files in Markdown format based on plain-text descriptions of agent roles and workflows.

## What This Skill Does

Transforms your descriptions of AI team members into properly formatted OpenCode agent files that can be used with the OpenCode CLI tool.

## When to Use This Skill

Use this skill when:
- You want to create OpenCode agents for your project
- You're setting up an AI team with multiple specialized agents
- You have descriptions of agent roles, responsibilities, and workflows
- You need to formalize agent configurations into the OpenCode format

## Output Location

**IMPORTANT**: All agent files are written to the **local project directory** at:
```
.opencode/agents/
```

The skill will create this directory if it doesn't exist. Do NOT use the global `~/.config/opencode/agents/` directory.

## File Naming Convention

Each agent file is named using the agent's name converted to lowercase with hyphens:
- `Team Lead` → `team-lead.md`
- `Solution Architect` → `solution-architect.md`
- `Code Reviewer` → `code-reviewer.md`

## OpenCode Agent Format

Each generated file follows this exact structure:

```markdown
---
description: [A short 1-sentence summary of what the agent does]
mode: [primary | subagent]
temperature: [optional, 0.1 for planning/strict agents, 0.4 for developers]
---
[The complete, detailed system prompt goes here. Include their role, constraints, workflow protocol, and core responsibilities exactly as described by the user.]
```

## How to Use This Skill

1. **Describe your agents**: Provide descriptions of each agent's role, responsibilities, workflow, and any specific constraints or behaviors.

2. **Specify the team structure**: Tell me how many agents you need and what each one does.

3. **I'll generate the files**: For each agent, I'll create a properly formatted `.md` file in `.opencode/agents/`.

## Examples

### Example 1: TDD Development Team

**User Input:**
"Create a TDD software development team with three agents:
1. A test-first developer who writes tests before implementation, follows red-green-refactor cycle, and ensures 100% test coverage
2. An implementation specialist who writes clean, efficient code to make tests pass, follows SOLID principles
3. A code reviewer who reviews both tests and implementation, suggests improvements, ensures code quality"

**Generated Files:**
- `.opencode/agents/test-first-developer.md`
- `.opencode/agents/implementation-specialist.md`
- `.opencode/agents/code-reviewer.md`

### Example 2: Documentation Team

**User Input:**
"I need two agents for documentation:
1. A technical writer who creates clear API documentation with examples
2. A documentation reviewer who checks for accuracy, completeness, and clarity"

**Generated Files:**
- `.opencode/agents/technical-writer.md`
- `.opencode/agents/documentation-reviewer.md`

## Instructions for the Model

When the user asks you to generate OpenCode agents:

1. **Parse the request**: Identify all agents mentioned by the user, including their names, roles, responsibilities, and any specific instructions.

2. **Determine mode**: 
   - Use `mode: primary` for agents that can be invoked directly by users
   - Use `mode: subagent` for agents that are called by other agents as part of a workflow

3. **Set temperature** (optional):
   - Use `temperature: 0.1` for agents that need to be precise, follow strict protocols, or do planning
   - Use `temperature: 0.4` for creative agents like developers or writers
   - Omit for default behavior

4. **Write description**: Create a concise 1-sentence summary of what the agent does.

5. **Write the system prompt**: Include all details the user provided about:
   - The agent's role and purpose
   - Their workflow and methodology
   - Constraints and rules they must follow
   - How they interact with other agents (if applicable)
   - Any specific tools or approaches they should use

6. **Generate files**: Create each `.md` file in `.opencode/agents/` with the proper format.

7. **Confirm completion**: Tell the user which files were created and provide a brief summary of each agent.

## Important Notes

- Preserve all details the user provides about each agent's behavior and responsibilities
- The system prompt should be comprehensive enough that another AI could read it and understand exactly how to act as that agent
- If the user mentions workflow protocols (like TDD, Agile, specific coding standards), include those in the agent's instructions
- Make sure to create the `.opencode/agents/` directory if it doesn't exist
- Always use the local project directory, never the global config directory

## Error Handling

If the user's request is unclear:
- Ask clarifying questions about what each agent should do
- Request specific details about workflows and responsibilities
- Confirm the team structure before generating files
