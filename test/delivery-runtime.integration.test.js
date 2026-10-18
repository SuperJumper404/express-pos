const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

process.env.ENV_FILE = "NUL";
const root = path.resolve(__dirname, "..");
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    const fixtureUrl = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
    const name = `smarteat-task17-node20-${crypto.randomBytes(6).toString("hex")}`;
    const context = fs.mkdtempSync(path.join(os.tmpdir(), "smarteat-task17-context-"));
    let created = false;
    try {
      // Positive source allowlist: no env, upload, git, node_modules or original checkout mount.
      const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(file =>
        ["index.js", "package.json", "package-lock.json"].includes(file) || /^src\/.*\.js$/.test(file) || /^db\/migrations\/\d+.*\.sql$/.test(file));
      for (const file of files) {
        const destination = path.join(context, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, file), destination);
      }
      assert.ok(files.includes("index.js") && files.includes("src/modules/m_deliveryQuotes.js"));
      console.log(`Filtered Docker context: ${files.length} allowlisted source files; no mounts`);
      docker(["create", "--name", name, "--label", "smarteat.task=task17", "--workdir", "/app",
        "--publish", "127.0.0.1::5005",
        "--env", "ENV_FILE=/dev/null", "--env", "NODE_ENV=local", "--env", "PORT=5005",
        "--env", "DBHOST=host.docker.internal", "--env", `DBPORT=${fixtureUrl.port || 3306}`,
        "--env", `DBUSER=${decodeURIComponent(fixtureUrl.username)}`, "--env", `DBPASS=${decodeURIComponent(fixtureUrl.password)}`,
        "--env", `DBNAME=${db.database}`, "--env", "JWTKEY=task17-runtime-disposable-jwt",
        "--env", "PUBLICIMAGEPATH=/tmp/task17-public", "node:20-alpine", "sh", "-c",
        "npm ci --include=dev --registry=https://registry.npmjs.org && node index.js"]);
      created = true;
      docker(["cp", `${context}/.`, `${name}:/app`]);
      docker(["start", name]);
      const running = spawn("docker", ["logs", "--follow", name], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      for (const stream of [running.stdout, running.stderr]) stream.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
      const completion = new Promise(resolve => running.on("exit", code => resolve(code)));
      try {
        let binding = "";
        for (let attempt = 0; attempt < 30 && !binding; attempt++) {
          binding = docker(["port", name, "5005/tcp"]);
          if (!binding) await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.match(binding, /^127\.0\.0\.1:\d+$/);
        const base = `http://${binding}/baseurl/api/v1`;
        const deadline = Date.now() + 240000;
        let ready = false;
        while (Date.now() < deadline) {
          if (running.exitCode !== null) throw new Error(`Node20 application exited before readiness: ${running.exitCode}`);
          try {
            const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { assert.deepEqual(await response.json(), { msg: "Hai" }); ready = true; break; }
          } catch (_) { /* Application is still installing or waiting for the fixture database. */ }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert.ok(ready, "actual whole application must listen after database readiness");
        const version = docker(["exec", name, "node", "--version"]);
        assert.match(version, /^v20\./);
        const mysqlVersion = (await db.readRows("SELECT VERSION() version"))[0].version;
        assert.equal(mysqlVersion, "8.0.33");
        assert.equal(docker(["inspect", "--format", "{{json .Mounts}}", name]), "[]");
        const bearer = jwt.sign({ id: 10, shopid: 7, access: 1 }, "task17-runtime-disposable-jwt");
        const availability = await fetch(`${base}/delivery/availability`, { headers: { Authorization: `Bearer ${bearer}` } });
        assert.equal(availability.status, 200);
        assert.deepEqual((await availability.json()).data, { enabled: false });
        const channels = await fetch(`${base}/customer-auth/channels`);
        assert.equal(channels.status, 200);
        assert.deepEqual((await channels.json()).data, { email: false, whatsapp: false });
        assert.match(output, /Server is running/);
        console.log(`PASS actual configured Node20 whole-app boot ${version}, MySQL ${mysqlVersion}, disabled legacy API without delivery/provider secrets, no Nano ID bridge`);
      } finally {
        docker(["stop", "--time", "2", name]);
        console.log(`Node20 log follower nativeExit=${await completion} (intentional container stop after smoke)`);
      }
    } finally {
      if (created) docker(["rm", "--force", name]);
      const resolved = path.resolve(context);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("smarteat-task17-context-"));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
