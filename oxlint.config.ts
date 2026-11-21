import { lintConfig } from "@sshkeda/check";

export default lintConfig({
  "scripts/container.ts": { allow: ["handlesEveryFailure"] },
  "scripts/internal/paper-configuration.ts": { allow: ["pollsWithADeadline"] },
  "scripts/internal/paper-commands.ts": { allow: ["spawnsCommands"] },
  "scripts/internal/supervise-paper.ts": { allow: ["waitsOnTimers", "pollsWithADeadline"] },
  ".dockerignore": { allow: ["hasAnUnlistedFileType"] },
  Dockerfile: { allow: ["hasAnUnlistedFileType"] },
  assets: { allow: ["isAnUnlistedDirectory"] },
  "assets/how-it-works.png": { allow: ["hasAnUnlistedFileType"] },
  "tests/internal/scenario.ts": {
    allow: ["spawnsCommands", "pollsWithADeadline", "handlesEveryFailure"],
  },
  "scripts/internal/alchemy-command.ts": { allow: ["spawnsCommands"] },
  "scripts/deploy.ts": { allow: ["handlesEveryFailure"] },
  "scripts/internal/minecraft-config.ts": { allow: ["readsConfig"] },
  "src/internal/cloudflare-exports.d.ts": { allow: ["isGeneratedByATool"] },
  "src/internal/world-storage.ts": { services: ["Backups"] },
  "src/internal/worker.ts": { allow: ["handlesEveryFailure"] },
});
