const {spawn} = require("child_process");

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const children = new Map();
let shuttingDown = false;

function startProcess(name, args) {
  console.log(`[AUTO] starting ${name}: ${npmCommand} ${args.join(" ")}`);
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    console.log(`[AUTO] ${name} exited code=${code} signal=${signal || ""}`);
    if (!shuttingDown) {
      setTimeout(() => startProcess(name, args), 5000);
    }
  });
}

function stopAll() {
  shuttingDown = true;
  for (const [name, child] of children.entries()) {
    console.log(`[AUTO] stopping ${name}`);
    child.kill(isWindows ? undefined : "SIGTERM");
  }
}

process.on("SIGINT", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});

startProcess("telegram-server", ["run", "telegram-server"]);
