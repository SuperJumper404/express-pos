#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const managedEnvFiles = [".env.local", ".env.staging", ".env.production"];
const zeroSha = /^0{40}$/;
const secretPattern =
  "(sk_(live|test)_[A-Za-z0-9]+|rk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|DOTENV_PRIVATE_KEY[A-Z0-9_]*=dotenvx://|-----BEGIN [A-Z ]*PRIVATE KEY-----)";
const sensitiveEnvKeys = new Set([
  "DATABASE_URL",
  "DBPASS",
  "JWTKEY",
  "MAILAPIKEY",
  "MAILSECRETKEY",
  "MYSQL_ROOT_PASSWORD",
  "MYSQL_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

const command = process.argv[2];
const flags = new Set(process.argv.slice(3));

function existingEnvFiles() {
  return managedEnvFiles.filter((file) => fs.existsSync(path.join(root, file)));
}

function run(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function git(args, options = {}) {
  return run("git", args, options);
}

function dotenvxCommand(args) {
  const cli = path.join(root, "node_modules", "@dotenvx", "dotenvx", "src", "cli", "dotenvx.js");

  if (!fs.existsSync(cli)) {
    throw new Error("dotenvx introuvable. Lance `npm install` avant d'utiliser les hooks env.");
  }

  return run(process.execPath, [cli, ...args]);
}

function dotenvxHelper(helper) {
  return require(path.join(root, "node_modules", "@dotenvx", "dotenvx", "src", "lib", "helpers", helper));
}

function setSkipWorktree(enabled) {
  const files = existingEnvFiles();
  if (!files.length) {
    return;
  }

  const flag = enabled ? "--skip-worktree" : "--no-skip-worktree";
  git(["update-index", flag, "--", ...files], { capture: true });
}

function encryptEnvFiles({ stage = false } = {}) {
  const files = existingEnvFiles();
  if (!files.length) {
    return;
  }

  setSkipWorktree(false);
  for (const file of files) {
    encryptEnvFile(file);
  }

  if (stage) {
    git(["add", "--", ...files]);
    scanStaged();
  }
}

function encryptEnvFile(file) {
  const filepath = path.join(root, file);
  const encryptValue = dotenvxHelper("encryptValue");
  const text = fs.readFileSync(filepath, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let publicKey = null;

  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (parsed && parsed.key === "DOTENV_PUBLIC_KEY") {
      publicKey = parsed.value;
      break;
    }
  }

  if (!publicKey) {
    throw new Error(`${file} doit contenir DOTENV_PUBLIC_KEY pour chiffrer avec la cle generique.`);
  }

  let changed = false;
  const encryptedLines = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed || parsed.key.startsWith("DOTENV_PUBLIC_KEY") || parsed.value.startsWith("encrypted:")) {
      return line;
    }

    changed = true;
    return `${parsed.key}=${encryptValue(parsed.value, publicKey)}`;
  });

  if (changed) {
    fs.writeFileSync(filepath, encryptedLines.join(newline), "utf8");
    console.log(`[env-hooks] encrypted ${file}`);
  } else {
    console.log(`[env-hooks] no changes ${file}`);
  }
}

function decryptEnvFiles({ soft = false, skipWorktree = false } = {}) {
  const files = existingEnvFiles();
  if (!files.length) {
    return;
  }

  let failed = false;

  for (const file of files) {
    const result = run(process.execPath, [
      path.join(root, "node_modules", "@dotenvx", "dotenvx", "src", "cli", "dotenvx.js"),
      "decrypt",
      "-f",
      file,
    ], { capture: true });

    if (result.status !== 0) {
      failed = true;
      const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
      console.warn(`[env-hooks] Dechiffrage impossible pour ${file}.`);
      if (output) {
        console.warn(redact(output));
      }
      console.warn("[env-hooks] Verifie .env.keys ou DOTENV_PRIVATE_KEY en local.");
    } else if (result.stdout.trim()) {
      console.log(redact(result.stdout.trim()));
    }
  }

  if (failed && !soft) {
    process.exit(1);
  }

  if (!failed && skipWorktree) {
    setSkipWorktree(true);
  }
}

function redact(text) {
  return text
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_$1_[REDACTED]")
    .replace(/rk_(live|test)_[A-Za-z0-9]+/g, "rk_$1_[REDACTED]")
    .replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]")
    .replace(/DOTENV_PRIVATE_KEY[A-Z0-9_]*=dotenvx:\/\/[^\s]+/g, "DOTENV_PRIVATE_KEY=[REDACTED]");
}

function failWithMatches(title, output) {
  console.error(`[env-hooks] ${title}`);
  console.error(redact(output.trim()));
  process.exit(1);
}

function scanStaged() {
  const result = git(["grep", "--cached", "-I", "-n", "-E", secretPattern, "--", "."], {
    capture: true,
  });

  if (result.status === 0) {
    failWithMatches("Secrets detectes dans l'index Git.", result.stdout);
  }

  scanEncryptedEnvInIndex();
}

function scanHead() {
  const result = git(["grep", "-I", "-n", "-E", secretPattern, "HEAD", "--", "."], {
    capture: true,
  });

  if (result.status === 0) {
    failWithMatches("Secrets detectes dans HEAD.", result.stdout);
  }

  scanEncryptedEnvInRevision("HEAD");
}

function getStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    return "";
  }
}

function listCommitsForPush(remoteName, stdin) {
  const commits = new Set();
  const lines = stdin.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || zeroSha.test(localSha)) {
      continue;
    }

    const args = zeroSha.test(remoteSha)
      ? ["rev-list", localSha, "--not", `--remotes=${remoteName}`]
      : ["rev-list", `${remoteSha}..${localSha}`];
    const result = git(args, { capture: true });

    if (result.status !== 0) {
      continue;
    }

    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((sha) => commits.add(sha));
  }

  if (!commits.size) {
    const head = git(["rev-parse", "HEAD"], { capture: true });
    if (head.status === 0 && head.stdout.trim()) {
      commits.add(head.stdout.trim());
    }
  }

  return [...commits];
}

function scanPush() {
  const remoteName = process.argv[3] || "origin";
  const commits = listCommitsForPush(remoteName, getStdin());

  for (const commit of commits) {
    const result = git(["grep", "-I", "-n", "-E", secretPattern, commit, "--", "."], {
      capture: true,
    });

    if (result.status === 0) {
      failWithMatches(`Secrets detectes dans le commit ${commit}.`, result.stdout);
    }

    scanEncryptedEnvInRevision(commit);
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
    return null;
  }

  const index = trimmed.indexOf("=");
  return {
    key: trimmed.slice(0, index),
    value: trimmed.slice(index + 1).replace(/^"(.*)"$/, "$1"),
  };
}

function assertSensitiveValuesEncrypted(file, content, source) {
  const offenders = [];

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || !sensitiveEnvKeys.has(parsed.key) || !parsed.value) {
      continue;
    }

    if (!parsed.value.startsWith("encrypted:")) {
      offenders.push(parsed.key);
    }
  }

  if (offenders.length) {
    console.error(
      `[env-hooks] ${file} contient des valeurs sensibles non chiffrees (${source}): ${offenders.join(", ")}`,
    );
    process.exit(1);
  }
}

function scanEncryptedEnvInIndex() {
  for (const file of managedEnvFiles) {
    const result = git(["show", `:${file}`], { capture: true });
    if (result.status === 0) {
      assertSensitiveValuesEncrypted(file, result.stdout, "index");
    }
  }
}

function scanEncryptedEnvInRevision(revision) {
  for (const file of managedEnvFiles) {
    const result = git(["show", `${revision}:${file}`], { capture: true });
    if (result.status === 0) {
      assertSensitiveValuesEncrypted(file, result.stdout, revision);
    }
  }
}

try {
  if (command === "encrypt") {
    encryptEnvFiles({ stage: flags.has("--stage") });
  } else if (command === "decrypt") {
    decryptEnvFiles({
      soft: flags.has("--soft"),
      skipWorktree: flags.has("--skip-worktree"),
    });
  } else if (command === "scan-staged") {
    scanStaged();
  } else if (command === "scan-head") {
    scanHead();
  } else if (command === "scan-push") {
    scanPush();
  } else {
    console.error("Usage: node scripts/env-hooks.js <encrypt|decrypt|scan-staged|scan-head|scan-push>");
    process.exit(1);
  }
} catch (error) {
  console.error(`[env-hooks] ${error.message}`);
  process.exit(1);
}
