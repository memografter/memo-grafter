import { runSmokeTests } from "../helpers/runner.js";
import { analyzeContextSmoke } from "./analyze-context.js";

await runSmokeTests([analyzeContextSmoke]);
