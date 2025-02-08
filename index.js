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
import { base, baseSepolia } from "viem/chains";
import { swap } from "./utils.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const program = new Command();

// Create Viem client for Base Sepolia
const client = createPublicClient({
  chain: base,
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

async function getSwapInputData(
  executorAddress,
  agentsAddresses,
  token,
  chainId,
  amountToSwap,
) {
  const swapMetadata = await swap({
    srcToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    destToken: token,
    amountSwap: amountToSwap,
    userAddress: executorAddress,
    chainId,
  });

  const data = encodeFunctionData({
    abi: [
      {
        inputs: [
          { internalType: "address", name: "_swapRouter", type: "address" },
          { internalType: "address", name: "_token", type: "address" },
          {
            internalType: "address[]",
            name: "_agentAddress",
            type: "address[]",
          },
          { internalType: "bytes", name: "_data", type: "bytes" },
          {
            internalType: "uint256",
            name: "_quotedTokenAmount",
            type: "uint256",
          },
        ],
        name: "aoSwap",
        outputs: [],
        stateMutability: "payable",
        type: "function",
      },
    ],
    functionName: "aoSwap",
    args: [
      swapMetadata.to,
      token,
      agentsAddresses,
      swapMetadata.inputData,
      swapMetadata.quotedAmount,
    ],
  });

  return data;
}

async function executeTrade(agents, token, chainId) {
  const agentWallets = agents.map((x) => x.walletAddress);

  const walletPath = path.join(__dirname, "wallet.json");
  const walletContent = await fs.readFile(walletPath, "utf-8");
  const executorWallet = JSON.parse(walletContent);

  let valueSwap = findBestETHAmount();

  const swapData = await getSwapInputData(
    executorWallet.walletAddress,
    agentWallets,
    token,
    chainId,
    valueSwap.amountToSwap,
  );

  const data = await privy.walletApi.ethereum.sendTransaction({
    walletId: executorWallet.walletId,
    caip2: `eip155:${chainId}`,
    transaction: {
      to: "0x8743E1ad7889d413C17901144d8CA91679977a67", //router
      value: toHex(parseUnits(valueSwap.randomEthers, 18)),
      chainId,
      data: swapData,
    },
  });

  return data.hash;
}

function findBestETHAmount() {
  const optETH = Math.random() * (0.00001 - 0.000001) + 0.000001;
  const normalizedOptETH = optETH.toFixed(8);
  const normalizedOptETHToNumber = Number(normalizedOptETH);

  const amountToSwap = parseUnits(
    (normalizedOptETHToNumber * 0.999).toString(),
    18,
  );

  return {
    randomEthers: normalizedOptETH,
    amountToSwap: amountToSwap.toString(),
  };
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
  .command("load-executor-details")
  .description("load executor details")
  .action(async () => {
    const walletPath = path.join(__dirname, "wallet.json");
    const walletContent = await fs.readFile(walletPath, "utf-8");
    let executorWallet = JSON.parse(walletContent);

    const spinner = ora("Loading ...").start();

    const balanceWei = await client.getBalance({
      address: executorWallet.walletAddress,
    });
    const balance = formatEther(balanceWei);

    spinner.stop();

    console.log(chalk.yellow(`\nExecutor:`));
    console.log(`Privy Wallet ID: ${executorWallet.walletId}`);
    console.log(`Privy Wallet Address: ${executorWallet.walletAddress}`);
    console.log(chalk.blue(`Balance: ${balance} ETH`));
  });

program
  .command("create-executor-wallet")
  .description("Create a new executor wallet and save to wallet.json")
  .action(async () => {
    try {
      const spinner = ora("Creating executor wallet...").start();

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

      spinner.succeed("Executor wallet created successfully");

      console.log(chalk.blue("\nExecutor Wallet Details:"));
      console.log(`Privy Wallet ID: ${chalk.yellow(id)}`);
      console.log(`Privy Wallet Address: ${chalk.yellow(address)}`);
    } catch (error) {
      console.error(chalk.red("Error creating wallet:"), error.message);
      process.exit(1);
    }
  });

program
  .command("chat")
  .description("Start a sequential chat with AI agents, starting with Alpha")
  .option("-d, --direct <message>", "Send message directly without prompt")
  .action(async (options) => {
    try {
      const result = await loadAgents();
      if (!result.success || result.agents.length === 0) {
        console.log(chalk.yellow(`\n🚫 ${result.message}`));
        return;
      }

      // Find Alpha agent
      const alphaAgent = result.agents.find((agent) => agent.name === "Alpha");
      if (!alphaAgent) {
        console.log(
          chalk.yellow("\n❌ Alpha agent not found in the available agents"),
        );
        return;
      }

      // Get remaining agents excluding Alpha
      const remainingAgents = result.agents.filter(
        (agent) => agent.name !== "Alpha",
      );

      while (true) {
        // First, process Alpha agent
        const alphaSpinner = ora(`🔍 Searching for Alpha signals...`).start();
        const alphaResponse = await sendToAgent(
          alphaAgent,
          "show me the latest boosted tokens",
        );
        alphaSpinner.succeed(`✨ Alpha signals detected`);

        let responseAlpha =
          alphaResponse.response[0].content.trending_tokens.sort(
            (a, b) => b.networkId - a.networkId,
          );
        console.log("\n📊 Alpha Tokens Found:");

        const tokensDetail = responseAlpha.map((x) => {
          console.log("🔗 Chain ID: ", x.networkId);
          console.log("📝 Name: ", chalk.green(x.name));
          console.log("🔤 Symbol: ", chalk.green(x.symbol));
          console.log("📍 Token Address: ", chalk.green(x.address));
          console.log("\n");
          return {
            name: x.name,
            symbol: x.symbol,
            address: x.address,
            decimals: x.decimals,
            chainId: x.networkId,
            message: `should i buy ${x.symbol}?`,
          };
        });

        for (const token of tokensDetail) {
          let tokenResult = {
            name: token.name,
            symbol: token.symbol,
            address: token.address,
            chainId: token.chainId,
          };

          for (const agent of remainingAgents) {
            const spinner = ora(
              `🤖 ${agent.name} (${agent.tag}) analyzing ${token.symbol}...`,
            ).start();
            const response = await sendToAgent(agent, token.message);

            if (
              !response ||
              response.response.length == 0 ||
              !response.response[0].content
            ) {
              spinner.fail(`❌ [${token.name}] Rejected by ${agent.name}`);
              await sleep(5000);
              continue;
            }

            const agentResponse = response.response[0].content;

            if (agentResponse) {
              tokenResult[agent.name] = tokenResult[agent.name] =
                agentResponse.decision === "YES" ||
                agentResponse.decision === "Yes" ||
                agentResponse.decision === "yes";
            }
            spinner.succeed(`✅ [${token.name}] Validated by ${agent.name}`);

            console.log(
              "💭 Analysis: ",
              chalk.yellowBright(response.response[0].content.reasoning),
            );
          }

          // if both true, then executor agent will be triggered
          if (tokenResult.Bizyugo && tokenResult.Murad) {
            const spinner2 = ora(
              "🚀 Initiating Shifu Trader Agent... Preparing transaction",
            ).start();
            let hash = await executeTrade(
              result.agents,
              token.address,
              token.chainId,
            );
            spinner2.succeed(`💫 Transaction executed! Hash: ${hash}`);
            await sleep(10000);
          }

          console.log("\n");
          // await sleep(10000);
        }

        await sleep(10000);
      }
    } catch (error) {
      console.error(chalk.red("⚠️ Error:"), error.message);
      process.exit(1);
    }
  });

const sleep = async (ms) => {
  return new Promise((r) => setTimeout(r, ms));
};

program.parse();
