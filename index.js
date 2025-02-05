#!/usr/bin/env node
import { Command } from "commander";
import axios from "axios";
import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const program = new Command();

// Configure the CLI
program
  .name("ai-chat")
  .description("CLI to interact with multiple AI agents")
  .version("1.0.0");

async function loadAgents() {
  const agentsDir = path.join(__dirname, "agents");

  try {
    // Check if agents directory exists
    await fs.access(agentsDir);

    // Read directory contents
    const files = await fs.readdir(agentsDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    if (jsonFiles.length === 0) {
      return {
        success: false,
        message: "No agent configurations found in the agents directory.",
        agents: [],
      };
    }

    // Load and parse agent files
    const agents = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const content = await fs.readFile(
            path.join(agentsDir, file),
            "utf-8",
          );
          return JSON.parse(content);
        } catch (err) {
          console.log(
            chalk.yellow(
              `Warning: Failed to load agent from ${file}: ${err.message}`,
            ),
          );
          return null;
        }
      }),
    );

    // Filter out any null values from failed loads
    const validAgents = agents.filter((agent) => agent !== null);

    if (validAgents.length === 0) {
      return {
        success: false,
        message: "No valid agent configurations found.",
        agents: [],
      };
    }

    return {
      success: true,
      agents: validAgents,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      // Directory doesn't exist
      try {
        await fs.mkdir(agentsDir);
        return {
          success: false,
          message: "Agents directory created. Please add agent configurations.",
          agents: [],
        };
      } catch (mkdirError) {
        return {
          success: false,
          message: `Failed to create agents directory: ${mkdirError.message}`,
          agents: [],
        };
      }
    }

    // Other errors
    return {
      success: false,
      message: `Error loading agents: ${error.message}`,
      agents: [],
    };
  }
}

async function sendToAgent(agent, message) {
  try {
    const formData = new FormData();
    formData.append("text", message);
    const response = await axios.post(agent.endpoint, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
    return {
      agent: agent.name,
      success: true,
      response: response.data,
    };
  } catch (error) {
    return {
      agent: agent.name,
      success: false,
      error: error.message,
    };
  }
}

function decidor(response) {
  let yes = 0;
  let no = 0;

  try {
    for (let i = 0; i < response.length; i++) {
      if (response[i][0].text == "Yes.") {
        yes++;
      } else {
        no++;
      }
    }
    return {
      yes,
      no,
    };
  } catch (error) {}
}

// Command to list all agents
program
  .command("list-agents")
  .description("List all configured agents")
  .action(async () => {
    const result = await loadAgents();

    if (!result.success) {
      console.log(chalk.yellow(`\n${result.message}`));
      return;
    }

    console.log(chalk.blue("\nConfigured Agents:"));
    result.agents.forEach((agent) => {
      console.log(chalk.yellow(`\n${agent.name}:`));
      console.log(`Endpoint: ${agent.endpoint}`);
    });
  });

// Main command to chat with all agents
program
  .command("chat")
  .description("Start a chat with all AI agents")
  .option("-d, --direct <message>", "Send message directly without prompt")
  .action(async (options) => {
    try {
      const result = await loadAgents();

      if (!result.success || result.agents.length === 0) {
        console.log(chalk.yellow(`\n${result.message}`));
        return;
      }

      const message =
        options.direct ||
        (
          await inquirer.prompt([
            {
              type: "input",
              name: "message",
              message: "Enter your message:",
              validate: (input) =>
                input.length > 0 || "Message cannot be empty",
            },
          ])
        ).message;

      const spinner = ora("Sending message to all agents...").start();
      const results = await Promise.all(
        result.agents.map((agent) => sendToAgent(agent, message)),
      );
      spinner.succeed("All agents responded");

      let count = decidor(results.map((x) => x.response));
      console.log(count);

      results.forEach((result) => {
        console.log(`\n${chalk.yellow(result.agent)}:`);
        if (result.success) {
          console.log(chalk.green("Response:"), result.response);
        } else {
          console.log(chalk.red("Error:"), result.error);
        }
      });
    } catch (error) {
      console.error(chalk.red("Error:"), error.message);
      process.exit(1);
    }
  });

program.parse();
