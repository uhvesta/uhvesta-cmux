import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

test("POST through ACP done becomes a completed review question", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmux-review-question-e2e-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const copilot = join(bin, "copilot");
  const port = 38_000 + Math.floor(Math.random() * 1_000);
  const serverRoot = join(import.meta.dir, "..");
  const fakeAcp = join(import.meta.dir, "fake-acp.ts");
  const bun = process.execPath;

  await Bun.write(join(root, ".keep"), "");
  await Bun.spawn(["/bin/mkdir", "-p", bin, repo]).exited;
  await writeFile(copilot, `#!/bin/sh\nexec ${JSON.stringify(bun)} ${JSON.stringify(fakeAcp)} "$@"\n`);
  await chmod(copilot, 0o755);

  const sidecar = Bun.spawn([bun, "server.ts", "--port", String(port)], {
    cwd: serverRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CMUX_AGENT_UI_CWD: repo },
  });

  async function waitForHealth() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) return;
      } catch {}
      await Bun.sleep(50);
    }
    throw new Error(`review-question sidecar did not start: ${await new Response(sidecar.stderr).text()}`);
  }

  try {
    await waitForHealth();
    const created = await fetch(`http://127.0.0.1:${port}/api/review-questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, question: "What changed?", reviewPrompt: "# Review\nNo tools." }),
    });
    if (created.status !== 202) throw new Error(`POST failed: ${created.status} ${await created.text()}`);
    const initial = await created.json() as { id?: string; status?: string };
    if (!initial.id || initial.status !== "running") {
      throw new Error(`unexpected POST response: ${JSON.stringify(initial)}`);
    }

    const deadline = Date.now() + 20_000;
    let result: { status?: string; answer?: string; error?: string } = {};
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/api/review-questions/${initial.id}`);
      result = await response.json() as typeof result;
      if (result.status !== "running") break;
      await Bun.sleep(50);
    }
    if (result.status !== "completed" || result.answer !== "OK") {
      throw new Error(`deferred ACP completion did not become a completed review result: ${JSON.stringify(result)}`);
    }
  } finally {
    sidecar.kill("SIGINT");
    await sidecar.exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("an accepted running review question survives sidecar process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmux-review-question-restart-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const copilot = join(bin, "copilot");
  const reviewState = join(root, "review-questions.json");
  const firstPort = 39_100 + Math.floor(Math.random() * 300);
  const secondPort = firstPort + 400;
  const serverRoot = join(import.meta.dir, "..");
  const fakeAcp = join(import.meta.dir, "fake-acp.ts");
  const bun = process.execPath;

  await Bun.spawn(["/bin/mkdir", "-p", bin, repo]).exited;
  await writeFile(copilot, `#!/bin/sh\nexec ${JSON.stringify(bun)} ${JSON.stringify(fakeAcp)} "$@"\n`);
  await chmod(copilot, 0o755);

  const launch = (port: number, delayMs: number) => Bun.spawn([bun, "server.ts", "--port", String(port)], {
    cwd: serverRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CMUX_AGENT_UI_CWD: repo,
      CMUX_AGENT_CHAT_REVIEW_STATE_FILE: reviewState,
      FAKE_ACP_DELAY_MS: String(delayMs),
    },
  });

  async function waitForHealth(port: number, process: ReturnType<typeof launch>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) return;
      } catch {}
      await Bun.sleep(50);
    }
    throw new Error(`review-question sidecar did not start: ${await new Response(process.stderr).text()}`);
  }

  let first = launch(firstPort, 5_000);
  let second: ReturnType<typeof launch> | undefined;
  try {
    await waitForHealth(firstPort, first);
    const created = await fetch(`http://127.0.0.1:${firstPort}/api/review-questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, question: "What changed?", reviewPrompt: "# Review\nNo tools." }),
    });
    if (created.status !== 202) throw new Error(`POST failed: ${created.status} ${await created.text()}`);
    const initial = await created.json() as { id?: string; status?: string };
    if (!initial.id || initial.status !== "running") throw new Error(`unexpected POST response: ${JSON.stringify(initial)}`);

    // SIGKILL deliberately bypasses cleanup; the new sidecar must recover from
    // the durable acceptance checkpoint rather than an in-memory session.
    first.kill("SIGKILL");
    await first.exited.catch(() => {});
    second = launch(secondPort, 0);
    await waitForHealth(secondPort, second);

    const deadline = Date.now() + 20_000;
    let result: { id?: string; status?: string; answer?: string; error?: string } = {};
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${secondPort}/api/review-questions/${initial.id}`);
      result = await response.json() as typeof result;
      if (result.status !== "running") break;
      await Bun.sleep(50);
    }
    if (result.id !== initial.id || result.status !== "completed" || result.answer !== "OK") {
      throw new Error(`restart did not resume the same completed review request: ${JSON.stringify(result)}`);
    }
  } finally {
    first.kill("SIGKILL");
    if (second) second.kill("SIGINT");
    await first.exited.catch(() => {});
    await second?.exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

test("DELETE cancels a running review question and removes its durable checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmux-review-question-delete-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const copilot = join(bin, "copilot");
  const reviewState = join(root, "review-questions.json");
  const port = 39_600 + Math.floor(Math.random() * 300);
  const serverRoot = join(import.meta.dir, "..");
  const fakeAcp = join(import.meta.dir, "fake-acp.ts");
  const bun = process.execPath;
  await Bun.spawn(["/bin/mkdir", "-p", bin, repo]).exited;
  await writeFile(copilot, `#!/bin/sh\nexec ${JSON.stringify(bun)} ${JSON.stringify(fakeAcp)} "$@"\n`);
  await chmod(copilot, 0o755);
  const sidecar = Bun.spawn([bun, "server.ts", "--port", String(port)], {
    cwd: serverRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CMUX_AGENT_UI_CWD: repo, CMUX_AGENT_CHAT_REVIEW_STATE_FILE: reviewState, FAKE_ACP_DELAY_MS: "5_000" },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {}
      await Bun.sleep(50);
    }
    const created = await fetch(`http://127.0.0.1:${port}/api/review-questions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, question: "What changed?", reviewPrompt: "# Review\nNo tools." }),
    });
    const initial = await created.json() as { id: string };
    const deleted = await fetch(`http://127.0.0.1:${port}/api/review-questions/${initial.id}`, { method: "DELETE" });
    if (deleted.status !== 204) throw new Error(`DELETE failed: ${deleted.status} ${await deleted.text()}`);
    await Bun.sleep(100);
    const lookup = await fetch(`http://127.0.0.1:${port}/api/review-questions/${initial.id}`);
    if (lookup.status !== 404) throw new Error(`deleted review question was resurrected: ${lookup.status} ${await lookup.text()}`);
  } finally {
    sidecar.kill("SIGINT");
    await sidecar.exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
