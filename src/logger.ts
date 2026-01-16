import pino from "pino";
import fs from "fs";
import path from "path";

// Ensure logs directory exists
const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: {
        destination: 1, // stdout
        colorize: true,
        translateTime: "SYS:standard",
      },
    },
    {
      target: "pino/file",
      options: {
        destination: path.join(logDir, "bot.log"),
        mkdir: true,
      },
    },
  ],
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);
