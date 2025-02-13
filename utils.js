import { constructSimpleSDK, SwapSide } from "@paraswap/sdk";
import { ParaSwapVersion } from "@paraswap/core";
import axios from "axios";

const srcDecimals = 18;
const destDecimals = 18;
const slippage = 5;

export async function swap({
  srcToken,
  // srcDecimals,
  destToken,
  // destDecimals,
  amountSwap,
  // slippage,
  userAddress,
  // receiver,
  chainId,
}) {
  try {
    if (slippage === 0 || slippage > 99) throw new Error("Invalid Slippage");

    const networkId = chainId;

    const paraswap = constructSimpleSDK({
      chainId: networkId,
      axios,
      version: ParaSwapVersion.V6,
    });

    const priceRoute = await paraswap.swap.getRate({
      srcToken,
      srcDecimals,
      destToken,
      destDecimals,
      amount: amountSwap,
      userAddress,
      side: SwapSide.SELL,
    });

    let slippageInBps = numberToBps(slippage);

    const txParams = await paraswap.swap.buildTx(
      {
        srcToken,
        destToken,
        srcAmount: amountSwap,
        priceRoute,
        userAddress,
        receiver: userAddress,
        // receiver,
        slippage: slippageInBps,
      },
      { ignoreChecks: true, onlyParams: false }
    );

    return {
      to: txParams.to,
      value: txParams.value,
      quotedAmount: priceRoute.destAmount,
      minReceivedAmount: minReceivedAmount(
        slippageInBps,
        BigInt(priceRoute.destAmount.toString())
      ),
      quotedDecimals: priceRoute.destDecimals,
      inputData: txParams.data,
    };
  } catch (ex) {
    console.error(`Error getting swap details from Paraswap: ${ex.message}`);
    return null;
  }
}

const numberToBps = (num) => Math.round(num * 100);

const minReceivedAmount = (slippageInBps, quotedAmount) => {
  const slippage = BigInt(slippageInBps);
  const slippageAmount = (slippage * quotedAmount) / BigInt(100_00);
  return (quotedAmount - slippageAmount).toString();
};
