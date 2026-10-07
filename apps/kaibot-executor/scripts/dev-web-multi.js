#!/usr/bin/env bun

import { spawn } from "child_process";

const backendPort = process.env.EXECUTOR_BACKEND_PORT || "8080";
const webPort = process.env.VITE_PORT || "1420";

console.log(`Starting executor:web with ports:`);
console.log(`  Backend: ${backendPort}`);
console.log(`  Web:     ${webPort}`);

// Run backend
const backend = spawn("bun", ["run", "dev"], {
  cwd: "node-backend",
  env: { ...process.env, PORT: backendPort },
  stdio: "inherit"
});

// Run frontend
const frontend = spawn("bun", ["vite", "--port", webPort], {
  env: process.env,
  stdio: "inherit"
});

// Handle graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  backend.kill();
  frontend.kill();
  process.exit();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Exit if either process exits
backend.on("exit", (code) => {
  console.log(`Backend exited with code ${code}`);
  frontend.kill();
  process.exit(code);
});

frontend.on("exit", (code) => {
  console.log(`Frontend exited with code ${code}`);
  backend.kill();
  process.exit(code);
});