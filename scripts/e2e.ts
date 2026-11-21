import { Task } from "@sshkeda/task";

import { runScenario } from "../tests/index.ts";

export default Task.make({
  name: "e2e",
  run: runScenario,
  timeout: "12 minutes",
  cleanup: "35 seconds",
});
