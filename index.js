#!/usr/bin/env node

import { Command } from "commander";
import axios from "axios";
import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { PrivyClient } from "@privy-io/server-auth";
import {
  createPublicClient,
  http,
  formatEther,
  encodeFunctionData,
  parseUnits,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const program = new Command();

// Create Viem client for Base Sepolia
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

const privy = new PrivyClient(
  process.env.PRIVY_APP_ID,
  process.env.PRIVY_APP_SECRET,
);

// Configure the CLI
program
  .name("ai-chat")
  .description("CLI to interact with multiple AI agents")
  .version("1.0.0");

async function loadAgents() {
  const agentsDir = path.join(__dirname, "agents");

  try {
    await fs.access(agentsDir);
    const files = await fs.readdir(agentsDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    if (jsonFiles.length === 0) {
      return {
        success: false,
        message: "No agent configurations found in the agents directory.",
        agents: [],
      };
    }

    // Load, parse, and process agent files
    const agents = await Promise.all(
      jsonFiles.map(async (file) => {
        const filePath = path.join(agentsDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const agent = JSON.parse(content);

        return agent;
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
      tag: agent.tag,
      success: true,
      response: response.data,
    };
  } catch (error) {
    return {
      agent: agent.name,
      tag: agent.tag,
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

function getSwapInputData(agentsAddresses, token) {
  const data = encodeFunctionData({
    abi: [
      {
        inputs: [
          {
            internalType: "address[]",
            name: "_agentAddress",
            type: "address[]",
          },
          { internalType: "address", name: "_tokenToReceive", type: "address" },
        ],
        name: "swap",
        outputs: [],
        stateMutability: "payable",
        type: "function",
      },
    ],
    functionName: "swap",
    args: [agentsAddresses, token],
  });

  return data;
}

async function executeTrade(agents, token) {
  const agentWallets = agents.map((x) => x.walletAddress);

  const walletPath = path.join(__dirname, "wallet.json");
  const walletContent = await fs.readFile(walletPath, "utf-8");
  const masterWallet = JSON.parse(walletContent);

  const swapData = getSwapInputData(agentWallets, token);

  const data = await privy.walletApi.ethereum.sendTransaction({
    walletId: masterWallet.walletId,
    caip2: "eip155:84532",
    transaction: {
      to: "0x7d0e4bd5799752892b4ed8aa18ab115534aec136", //router
      value: toHex(parseUnits("0.005", 18)),
      chainId: 84532,
      data: swapData,
    },
  });

  // console.log(`tx hash `, data.hash);
  //
  return data.hash;
}

program
  .command("list-agents")
  .description("List all configured agents")
  .action(async () => {
    const spinner = ora("Loading agents...").start();

    const result = await loadAgents();
    if (!result.success) {
      spinner.stop();
      console.log(chalk.yellow(`\n${result.message}`));
      return;
    }

    // Use Promise.all to fetch balances concurrently
    const agentsWithBalances = await Promise.all(
      result.agents.map(async (agent) => {
        let balance = "N/A";
        try {
          const balanceWei = await client.getBalance({
            address: agent.walletAddress,
          });
          balance = formatEther(balanceWei);
        } catch (error) {
          console.log(
            chalk.red(
              `Error fetching balance for ${agent.name}: ${error.message}`,
            ),
          );
        }

        return {
          ...agent,
          balance,
        };
      }),
    );

    spinner.stop();

    console.log(chalk.blue("\nConfigured Agents:"));

    // Print agents with their balances
    agentsWithBalances.forEach((agent) => {
      console.log(chalk.yellow(`\n${agent.name}:`));
      console.log(`Wallet Address: ${agent.walletAddress}`);
      console.log(chalk.blue(`Balance: ${agent.balance} ETH`));
      console.log(`Endpoint: ${agent.endpoint}`);
    });
  });

program
  .command("load-master")
  .description("load master details")
  .action(async () => {
    const walletPath = path.join(__dirname, "wallet.json");
    const walletContent = await fs.readFile(walletPath, "utf-8");
    let masterWallet = JSON.parse(walletContent);

    const spinner = ora("Loading ...").start();

    const balanceWei = await client.getBalance({
      address: masterWallet.walletAddress,
    });
    const balance = formatEther(balanceWei);

    spinner.stop();

    console.log(chalk.yellow(`\nMaster:`));
    console.log(`Privy Wallet ID: ${masterWallet.walletId}`);
    console.log(`Privy Wallet Address: ${masterWallet.walletAddress}`);
    console.log(chalk.blue(`Balance: ${balance} ETH`));
  });

program
  .command("create-wallet")
  .description("Create a new master wallet and save to wallet.json")
  .action(async () => {
    try {
      const spinner = ora("Creating master wallet...").start();

      // Create Privy wallet
      const { id, address } = await privy.walletApi.create({
        chainType: "ethereum",
      });

      // Prepare wallet data
      const walletData = {
        walletId: id,
        walletAddress: address,
      };

      // Save to wallet.json
      const walletPath = path.join(__dirname, "wallet.json");
      await fs.writeFile(
        walletPath,
        JSON.stringify(walletData, null, 2),
        "utf-8",
      );

      spinner.succeed("Master wallet created successfully");

      console.log(chalk.blue("\nMaster Wallet Details:"));
      console.log(`Privy Wallet ID: ${chalk.yellow(id)}`);
      console.log(`Privy Wallet Address: ${chalk.yellow(address)}`);
    } catch (error) {
      console.error(chalk.red("Error creating wallet:"), error.message);
      process.exit(1);
    }
  });

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

      const results = [];

      // Process agents sequentially
      for (const agent of result.agents) {
        const spinner = ora(
          `Sending message to ${agent.name} as ${agent.tag}...`,
        ).start();
        const response = await sendToAgent(agent, message);
        results.push(response);
        spinner.succeed(`${agent.name} responded`);

        // // Display the response immediately
        // console.log(`\n${chalk.yellow(response.agent)} (${response.tag})`);
        // if (response.success) {
        //   console.log(chalk.green("Response:"), response.response);
        // } else {
        //   console.log(chalk.red("Error:"), response.error);
        // }
      }

      let count = decidor(results.map((x) => x.response));
      // console.log("Count", count);

      if (count.yes == 2) {
        // console.log(`\n${chalk.yellow("Shifu")} (Trader Agent)`);
        // const spinner2 = ora("\nExecuting on-chain txs... ").start();
        const spinner2 = ora(
          "Sending message to Shifu Trader Agent... Executing onchain tx",
        ).start();

        await sleep(3000);

        let hash = await executeTrade(
          result.agents,
          "0x9F46FC7156D2d5152A6706cDB31E74534d9491d6",
        );

        spinner2.succeed(`Shifu responded, ${hash}`);
      }
    } catch (error) {
      console.error(chalk.red("Error:"), error.message);
      process.exit(1);
    }
  });

const sleep = async (ms) => {
  return new Promise((r) => setTimeout(r, ms));
};

program.parse();
