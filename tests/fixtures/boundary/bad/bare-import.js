// Fixture: the violation this check exists to catch — reaching into the 9Router
// engine from inside the boundary. Must be reported, must fail CI.
import { getExecutor } from "open-sse/executors/index.js";

export const executor = getExecutor;
