import { runEngine } from "../../dist/index.js";

await runEngine({
  async check() {
    return { version: "1.0.0", path: "/usr/local/bin/legacy" };
  },
  async run(req) {
    return { text: req.params.prompt };
  },
  async usage() {
    return {};
  },
});
