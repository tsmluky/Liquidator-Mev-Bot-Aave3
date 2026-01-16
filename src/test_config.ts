import { loadConfig } from "./config.js";
console.log("Config loaded");
const c = loadConfig();
console.log("Config:", c.CHAIN_ID);
