import { providerFromEnv } from "../src/harness/llm.js";

const llm = providerFromEnv();
const res = await llm.complete([{ role: "user", content: "Reply with exactly: ok" }], []);
console.log("MODEL:", llm.model);
console.log("CONTENT:", JSON.stringify(res.content));
console.log("TOOLS:", res.toolCalls.length, "FINISH:", res.finishReason);
