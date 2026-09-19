import { ToolRegistry } from "../harness/tools.js";
import { readFileTool, writeFileTool, listDirTool, globTool, grepTool } from "./fs.js";
import { runBashTool, gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from "./shell.js";
import { deployTool } from "./deploy.js";

/** The fullstack coding agent's toolset. */
export function codingToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(listDirTool)
    .register(globTool)
    .register(grepTool)
    .register(runBashTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(gitLogTool)
    .register(gitCommitTool)
    .register(deployTool);
}
