import type { ToolDef } from "./ai-client.js";

export type ToolCapability =
  | "core_business"
  | "research"
  | "document"
  | "communication"
  | "automation"
  | "local_ops"
  | "collaboration"
  | "integration";

export interface RegisteredToolDefinition {
  definition: ToolDef;
  capabilities: ToolCapability[];
  origin: "core" | "local" | "feishu";
}

const TOOL_CAPABILITY_MAP: Record<string, ToolCapability[]> = {
  opc_manage: ["core_business"],
  opc_finance: ["core_business"],
  opc_legal: ["core_business", "document"],
  opc_hr: ["core_business"],
  opc_project: ["core_business"],
  opc_schedule: ["core_business", "automation"],
  opc_order: ["core_business", "document"],
  opc_document: ["document", "core_business"],
  opc_report: ["document", "research"],
  opc_data_analysis: ["research", "core_business"],
  opc_search: ["research"],
  opc_webpage: ["research"],
  native_web_search: ["research"],
  native_web_extract: ["research"],
  native_code_interpreter: ["research", "automation"],
  opc_email: ["communication"],
  setup_email: ["communication", "integration"],
  read_email: ["communication"],
  reply_email: ["communication"],
  opc_service_config: ["integration"],
  invoke_skill: ["automation"],
  find_skills: ["automation"],
  opc_video: ["document", "automation"],
};

function uniqueCapabilities(capabilities: ToolCapability[]): ToolCapability[] {
  return [...new Set(capabilities)];
}

export function inferToolCapabilities(toolName: string): ToolCapability[] {
  if (TOOL_CAPABILITY_MAP[toolName]) return TOOL_CAPABILITY_MAP[toolName];
  if (toolName.startsWith("local_")) return ["local_ops"];
  if (toolName.startsWith("feishu_")) return ["integration", "communication"];
  return ["automation"];
}

export function inferToolOrigin(toolName: string): RegisteredToolDefinition["origin"] {
  if (toolName.startsWith("local_")) return "local";
  if (toolName.startsWith("feishu_")) return "feishu";
  return "core";
}

export function registerToolDefinition(definition: ToolDef): RegisteredToolDefinition {
  return {
    definition,
    capabilities: uniqueCapabilities(inferToolCapabilities(definition.function.name)),
    origin: inferToolOrigin(definition.function.name),
  };
}

export function filterToolDefinitionsByCapabilities(
  definitions: RegisteredToolDefinition[],
  requestedCapabilities?: ToolCapability[],
): RegisteredToolDefinition[] {
  if (!requestedCapabilities || requestedCapabilities.length === 0) return definitions;
  const requested = new Set(requestedCapabilities);
  return definitions.filter((definition) => definition.capabilities.some((capability) => requested.has(capability)));
}

