/** Step 0: prove the claimed key works. Prints only your DID and balance. */
import { formatTokens, getNodeUrl } from "@terminal3/t3n-sdk";
import { devSession, requireKey } from "./t3n-lib.js";

const { t3n, did, e } = await devSession(requireKey());
console.log(`Connected to T3N ${e} (${getNodeUrl()}) as ${did}`);
const bal = await t3n.getBalance();
console.log(`Balance: ${formatTokens(bal.available)} credits available`);
