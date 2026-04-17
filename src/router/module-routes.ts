import type { AuthRequest } from "../auth/middleware.js";
import { handleGetCanvas, handleUpdateCanvas, handleGetCompass, handleUpdateCompass, handleAddBizModel, handleDeleteBizModel, handleGetMonitor, handleGetChannels, handleSaveChannel, handleGetToolConfig, handleSaveToolConfig, handleGetClosures, handleCreateClosure, handleDeleteClosure, handleGetAiConfig, handleSaveAiConfig, handleTestAiConfig, handleGetSearchConfig, handleSaveSearchConfig, handleTestSearchConfig, handleGetServiceConfig, handleSaveServiceConfig, handleInitStaff, handleToggleStaff, handleEditStaff, handleGetStaff, handleListSkills, handleCreateSkill, handleUpdateSkill, handleDeleteSkill, handleToggleSkill, handleInstallCatalogSkill, handleImportSkillFromUrl, handlePreviewImportSkill, handleListRemoteSkills, handleSearchEcosystemSkills, handleInstallEcosystemSkill, handleGetModels, handleGetUserModel, handleSetUserModel, handleGetUsageLogs, handleListOpportunityBattles, handleUpsertOpportunityBattle, handleGetOpportunityMapData, handleGetOpportunityMerchantMatches, handleListOpportunityMatchBoard, handleCreateOpportunityExecutionPack, handleGetOpportunityEnrichment, handleWarmOpportunityEnrichments, handleGetMemoryCenter, handleUpdateMemory, handleUpdateReflection, handlePromoteReflectionToSkill } from "../api/module-api.js";
import { handleGetScheduledTasks, handleDeleteScheduledTask } from "../api/scheduler-api.js";
import { handleListSchedules, handleCreateSchedule, handleUpdateSchedule, handleDeleteSchedule } from "../api/schedule-api.js";
import { handleVideoRender, handleVideoJobs, handleVideoJobStatus, handleVideoFiles, handleVideoOpenFolder } from "../api/video-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleModuleRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  const canvasMatch = pathname.match(/^\/api\/companies\/([^/]+)\/canvas$/);
  if (canvasMatch && method === "GET") return await handled(handleGetCanvas(req as AuthRequest, res, db, canvasMatch[1]));
  if (canvasMatch && method === "PUT") return await handled(handleUpdateCanvas(req as AuthRequest, res, db, canvasMatch[1]));

  const compassMatch = pathname.match(/^\/api\/companies\/([^/]+)\/compass$/);
  if (compassMatch && method === "GET") return await handled(handleGetCompass(req as AuthRequest, res, db, compassMatch[1]));
  if (compassMatch && method === "PUT") return await handled(handleUpdateCompass(req as AuthRequest, res, db, compassMatch[1]));

  const bizModelMatch = pathname.match(/^\/api\/companies\/([^/]+)\/biz-models$/);
  if (bizModelMatch && method === "POST") return await handled(handleAddBizModel(req as AuthRequest, res, db, bizModelMatch[1]));

  const bizModelDelMatch = pathname.match(/^\/api\/biz-models\/([^/]+)$/);
  if (bizModelDelMatch && method === "DELETE") return await handled(handleDeleteBizModel(req as AuthRequest, res, db, bizModelDelMatch[1]));

  const monitorMatch = pathname.match(/^\/api\/companies\/([^/]+)\/monitor$/);
  if (monitorMatch && method === "GET") return await handled(handleGetMonitor(req as AuthRequest, res, db, monitorMatch[1]));

  const channelsMatch = pathname.match(/^\/api\/companies\/([^/]+)\/channels$/);
  if (channelsMatch && method === "GET") return await handled(handleGetChannels(req as AuthRequest, res, db, channelsMatch[1]));
  if (channelsMatch && method === "POST") return await handled(handleSaveChannel(req as AuthRequest, res, db, channelsMatch[1]));

  if (pathname === "/api/tool-config" && method === "GET") return await handled(handleGetToolConfig(req as AuthRequest, res, db));
  if (pathname === "/api/tool-config" && method === "POST") return await handled(handleSaveToolConfig(req as AuthRequest, res, db));
  if (pathname === "/api/ai-config" && method === "GET") return await handled(handleGetAiConfig(req as AuthRequest, res, db));
  if (pathname === "/api/ai-config" && method === "POST") return await handled(handleSaveAiConfig(req as AuthRequest, res, db));
  if (pathname === "/api/ai-config/test" && method === "POST") return await handled(handleTestAiConfig(req as AuthRequest, res, db));
  if (pathname === "/api/search-config" && method === "GET") return await handled(handleGetSearchConfig(req as AuthRequest, res, db));
  if (pathname === "/api/search-config" && method === "POST") return await handled(handleSaveSearchConfig(req as AuthRequest, res, db));
  if (pathname === "/api/search-config/test" && method === "POST") return await handled(handleTestSearchConfig(req as AuthRequest, res, db));
  if (pathname === "/api/service-config" && method === "GET") return await handled(handleGetServiceConfig(req as AuthRequest, res, db));
  if (pathname === "/api/service-config" && method === "POST") return await handled(handleSaveServiceConfig(req as AuthRequest, res, db));

  const closureItemMatch = pathname.match(/^\/api\/companies\/([^/]+)\/closures\/([^/]+)$/);
  if (closureItemMatch && method === "DELETE") return await handled(handleDeleteClosure(req as AuthRequest, res, db, closureItemMatch[1], closureItemMatch[2]));

  const closureMatch = pathname.match(/^\/api\/companies\/([^/]+)\/closures$/);
  if (closureMatch && method === "GET") return await handled(handleGetClosures(req as AuthRequest, res, db, closureMatch[1]));
  if (closureMatch && method === "POST") return await handled(handleCreateClosure(req as AuthRequest, res, db, closureMatch[1]));

  const staffInitMatch = pathname.match(/^\/api\/staff\/([^/]+)\/init$/);
  if (staffInitMatch && method === "POST") return await handled(handleInitStaff(req as AuthRequest, res, db, staffInitMatch[1]));

  const staffToggleMatch = pathname.match(/^\/api\/staff\/([^/]+)\/toggle$/);
  if (staffToggleMatch && method === "PATCH") return await handled(handleToggleStaff(req as AuthRequest, res, db, staffToggleMatch[1]));

  const staffEditMatch = pathname.match(/^\/api\/staff\/([^/]+)\/edit$/);
  if (staffEditMatch && method === "PATCH") return await handled(handleEditStaff(req as AuthRequest, res, db, staffEditMatch[1]));

  const staffGetMatch = pathname.match(/^\/api\/staff\/([^/]+)$/);
  if (staffGetMatch && method === "GET") return await handled(handleGetStaff(req as AuthRequest, res, db, staffGetMatch[1]));

  if (pathname === "/api/skills" && method === "GET") return await handled(handleListSkills(req as AuthRequest, res, db));
  if (pathname === "/api/skills" && method === "POST") return await handled(handleCreateSkill(req as AuthRequest, res, db));

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && method === "PUT") return await handled(handleUpdateSkill(req as AuthRequest, res, db, skillMatch[1]));
  if (skillMatch && method === "DELETE") return await handled(handleDeleteSkill(req as AuthRequest, res, db, skillMatch[1]));

  const skillToggleMatch = pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (skillToggleMatch && method === "PATCH") return await handled(handleToggleSkill(req as AuthRequest, res, db, skillToggleMatch[1]));

  if (pathname === "/api/skills/catalog/install" && method === "POST") return await handled(handleInstallCatalogSkill(req as AuthRequest, res, db));
  if (pathname === "/api/skills/import/preview" && method === "POST") return await handled(handlePreviewImportSkill(req as AuthRequest, res));
  if (pathname === "/api/skills/import" && method === "POST") return await handled(handleImportSkillFromUrl(req as AuthRequest, res, db));
  if (pathname === "/api/skills/remote-catalog" && method === "GET") return await handled(handleListRemoteSkills(req as AuthRequest, res));
  if (pathname === "/api/skills/ecosystem/search" && method === "GET") return await handled(handleSearchEcosystemSkills(req as AuthRequest, res));
  if (pathname === "/api/skills/ecosystem/install" && method === "POST") return await handled(handleInstallEcosystemSkill(req as AuthRequest, res, db));
  if (pathname === "/api/scheduled-tasks" && method === "GET") return await handled(handleGetScheduledTasks(req as AuthRequest, res, db));

  const scheduleMatch = pathname.match(/^\/api\/scheduled-tasks\/([^/]+)$/);
  if (scheduleMatch && method === "DELETE") return await handled(handleDeleteScheduledTask(req as AuthRequest, res, db, scheduleMatch[1]));

  if (pathname === "/api/schedules" && method === "GET") return await handled(handleListSchedules(req as AuthRequest, res, db));
  if (pathname === "/api/schedules" && method === "POST") return await handled(handleCreateSchedule(req as AuthRequest, res, db));

  const scheduleItemMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleItemMatch && method === "PUT") return await handled(handleUpdateSchedule(req as AuthRequest, res, db, scheduleItemMatch[1]));
  if (scheduleItemMatch && method === "DELETE") return await handled(handleDeleteSchedule(req as AuthRequest, res, db, scheduleItemMatch[1]));

  if (pathname === "/api/models" && method === "GET") return await handled(handleGetModels(req as AuthRequest, res, db));
  if (pathname === "/api/user/model" && method === "GET") return await handled(handleGetUserModel(req as AuthRequest, res, db));
  if (pathname === "/api/user/model" && method === "POST") return await handled(handleSetUserModel(req as AuthRequest, res, db));
  if (pathname === "/api/user/usage-logs" && method === "GET") return await handled(handleGetUsageLogs(req as AuthRequest, res, db));
  if (pathname === "/api/user/memory-center" && method === "GET") return await handled(handleGetMemoryCenter(req as AuthRequest, res, db));
  const memoryMatch = pathname.match(/^\/api\/user\/memories\/([^/]+)$/);
  if (memoryMatch && method === "PATCH") return await handled(handleUpdateMemory(req as AuthRequest, res, db, memoryMatch[1]));
  const reflectionMatch = pathname.match(/^\/api\/user\/reflections\/([^/]+)$/);
  if (reflectionMatch && method === "PATCH") return await handled(handleUpdateReflection(req as AuthRequest, res, db, reflectionMatch[1]));
  const reflectionPromoteMatch = pathname.match(/^\/api\/user\/reflections\/([^/]+)\/promote-skill$/);
  if (reflectionPromoteMatch && method === "POST") return await handled(handlePromoteReflectionToSkill(req as AuthRequest, res, db, reflectionPromoteMatch[1]));
  if (pathname === "/api/intel/opportunity-map" && method === "GET") return await handled(handleGetOpportunityMapData(req as AuthRequest, res, db));
  if (pathname === "/api/admin/opportunity-enrichments/warmup" && method === "POST") return await handled(handleWarmOpportunityEnrichments(req as AuthRequest, res, db));
  if (pathname === "/api/intel/match-board" && method === "GET") return await handled(handleListOpportunityMatchBoard(req as AuthRequest, res, db));
  const opportunityMatchRoute = pathname.match(/^\/api\/intel\/opportunities\/([^/]+)\/matches$/);
  if (opportunityMatchRoute && method === "GET") return await handled(handleGetOpportunityMerchantMatches(req as AuthRequest, res, db, decodeURIComponent(opportunityMatchRoute[1])));
  const opportunityEnrichmentRoute = pathname.match(/^\/api\/intel\/opportunities\/([^/]+)\/enrichment$/);
  if (opportunityEnrichmentRoute && method === "GET") return await handled(handleGetOpportunityEnrichment(req as AuthRequest, res, db, decodeURIComponent(opportunityEnrichmentRoute[1])));
  const opportunityExecutionRoute = pathname.match(/^\/api\/intel\/opportunities\/([^/]+)\/execution-pack$/);
  if (opportunityExecutionRoute && method === "POST") return await handled(handleCreateOpportunityExecutionPack(req as AuthRequest, res, db, decodeURIComponent(opportunityExecutionRoute[1])));
  if (pathname === "/api/opportunity-battles" && method === "GET") return await handled(handleListOpportunityBattles(req as AuthRequest, res, db));

  const opportunityBattleMatch = pathname.match(/^\/api\/opportunity-battles\/([^/]+)$/);
  if (opportunityBattleMatch && method === "PUT") return await handled(handleUpsertOpportunityBattle(req as AuthRequest, res, db, opportunityBattleMatch[1]));

  // ── AI 视频生成 ──────────────────────────────────────────────
  if (pathname === "/api/video/render" && method === "POST") return await handled(handleVideoRender(req as AuthRequest, res, db));
  if (pathname === "/api/video/jobs" && method === "GET") return await handled(handleVideoJobs(req as AuthRequest, res, db));
  if (pathname === "/api/video/files" && method === "GET") return await handled(handleVideoFiles(req as AuthRequest, res));
  if (pathname === "/api/video/open-folder" && method === "POST") return await handled(handleVideoOpenFolder(req as AuthRequest, res));
  const videoJobMatch = pathname.match(/^\/api\/video\/job\/([^/]+)$/);
  if (videoJobMatch && method === "GET") return await handled(handleVideoJobStatus(req as AuthRequest, res, db, videoJobMatch[1]));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
