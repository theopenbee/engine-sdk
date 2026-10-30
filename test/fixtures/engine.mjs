import { execFileSync } from "node:child_process";
import { runEngine, spawnCli, log } from "../../dist/index.js";

await runEngine({
  async check() {
    return { version: "1.2.3", path: "/usr/local/bin/fake" };
  },
  async run(req) {
    const { prompt } = req.params;
    if (prompt === "stray") {
      console.log("stray log line");
      console.info("stray info line");
      console.debug("stray debug line");
      log.info("sdk info line");
      return { text: "ok" };
    }
    if (prompt === "boom") {
      throw new Error("engine exploded");
    }
    if (prompt === "context") {
      const { params, ...rest } = req;
      return { text: JSON.stringify({ ...rest, role: params.role, work_dir: params.work_dir, resume: params.resume, extra_args: params.extra_args, mcp: params.mcp }) };
    }
    if (prompt === "pgid") {
      const seen = [];
      const result = await spawnCli({
        command: "sh",
        args: ["-c", "ps -o pgid= -p $$"],
        cwd: process.cwd(),
        logPath: req.params.log_path,
        onStdoutLine: (line) => {
          seen.push(line.trim());
          return null;
        },
      });
      const own = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim();
      return { text: JSON.stringify({ child: seen[0], own, code: result.code }) };
    }
    return { text: prompt, error: prompt === "with-error" ? "cli failed" : undefined };
  },
  async usage(req) {
    const out = {};
    for (const id of req.params.session_ids) {
      out[id] = [{ model: "m-" + id, input_tokens: 1, output_tokens: 2, cache_creation_tokens: 3, cache_read_tokens: 4 }];
    }
    return out;
  },
});
