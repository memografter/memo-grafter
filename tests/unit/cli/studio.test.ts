import http from "node:http";
import { describe, expect, it } from "vitest";
import { handleStudioRequest, listenOnAvailablePort } from "../../../cli/commands/studio.js";
import { renderStudioHtml } from "../../../cli/studio/frontend.js";

describe("memo-grafter studio", () => {
  it("serves the bundled frontend and status endpoint", async () => {
    const state = {
      databaseStatus: "connected" as const,
      sessionCount: 3,
      studioUrl: "http://localhost:2891",
    };
    const server = http.createServer((request, response) => {
      handleStudioRequest(request, response, state);
    });
    const port = await listenOnAvailablePort(server, "127.0.0.1", 0);

    try {
      const html = await fetchText(`http://127.0.0.1:${port}/`);
      const status = await fetchJson(`http://127.0.0.1:${port}/api/status`);
      const missing = await fetchText(`http://127.0.0.1:${port}/missing`);

      expect(html.status).toBe(200);
      expect(html.body).toContain("MemoGrafter Studio");
      expect(html.body).toContain("session-list");
      expect(html.body).toContain("session-search");
      expect(html.body).toContain("title-editor");
      expect(html.body).toContain("title-button");
      expect(html.body).toContain("theme-toggle");
      expect(html.body).toContain("graph-stage");
      expect(html.body).toContain("tab-graph");
      expect(html.body).toContain("tab-tables");
      expect(html.body).toContain("tab-preview");
      expect(html.body).toContain("Prompt Preview");
      expect(html.body).toContain("workspace-panel");
      expect(html.body).toContain("graph-view-mode");
      expect(html.body).toContain("graph-edge-mode");
      expect(html.body).toContain("node-type-filter");
      expect(html.body).toContain("graph-search-input");
      expect(html.body).toContain("graph-search-clear");
      expect(html.body).not.toContain("graph-search-prev");
      expect(html.body).not.toContain("graph-search-next");
      expect(html.body).toContain("tag-filter");
      expect(html.body).toContain("lifecycle-filter");
      expect(html.body).toContain("refresh-sessions");
      expect(html.body).toContain("refresh-graph");
      expect(html.body).toContain('fetchJson("/api/sessions")');
      expect(html.body).toContain('method: "PATCH"');
      expect(html.body).toContain('"/api/sessions/" + encodeURIComponent(sessionId) + "/graph"');
      expect(html.body).toContain('"/api/sessions/" + encodeURIComponent(sessionId) + "/tables"');
      expect(status.status).toBe(200);
      expect(status.body).toEqual(state);
      expect(missing.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("uses the next available port when the preferred port is busy", async () => {
    const occupied = http.createServer((_request, response) => {
      response.end("occupied");
    });
    const occupiedPort = await listenOnAvailablePort(occupied, "127.0.0.1", 0);
    const server = http.createServer((_request, response) => {
      response.end("studio");
    });

    try {
      const port = await listenOnAvailablePort(server, "127.0.0.1", occupiedPort);

      expect(port).toBe(occupiedPort + 1);
    } finally {
      await closeServer(server);
      await closeServer(occupied);
    }
  });

  it("bundles node inspection and lifecycle maintenance workflows", () => {
    const html = renderStudioHtml({
      databaseStatus: "connected",
      sessionCount: 1,
      studioUrl: "http://localhost:2891",
    });
    const inlineScript = extractInlineScript(html);

    expect(() => new Function(inlineScript)).not.toThrow();
    expect(html).toContain("--surface");
    expect(html).toContain('--surface-code');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain("loadTheme");
    expect(html).toContain("applyTheme");
    expect(html).toContain("memo-grafter-studio-theme");
    expect(html).toContain("Connected memories");
    expect(html).toContain("Source metadata");
    expect(html).toContain("Relationships");
    expect(html).toContain("renderDetailsPanel");
    expect(html).toContain("renderGraphOverviewDetails");
    expect(html).toContain("selectedEntity");
    expect(html).toContain("resolveGraphEntity");
    expect(html).toContain("autoSelectSessionId");
    expect(html).toContain("void loadGraph(autoSelectSessionId)");
    expect(html).toContain("selectedTopicIdForGraph");
    expect(html).toContain('state.filters.nodeType === "memories" && !selectedTopicId');
    expect(html).toContain("showAllMemories");
    expect(html).toContain("memory.raw.topicNodeId === selectedTopicId");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("handleTabKeydown");
    expect(html).toContain("handleEnterOrSpace");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="graph-summary" aria-live="polite"');
    expect(html).toContain('node.addEventListener("pointerdown"');
    expect(html).toContain('aria-expanded="');
    expect(html).toContain("hoveredGraphNodeId");
    expect(html).toContain("renderCurve");
    expect(html).toContain("graph-arrow-topic");
    expect(html).toContain("graph-arrow-memory");
    expect(html).toContain("graph-arrow-attachment");
    expect(html).toContain("status-badge");
    expect(html).toContain("lifecycleBadge");
    expect(html).toContain("connectedNodeIds");
    expect(html).toContain("graphSearchMatches");
    expect(html).toContain("navigateGraphSearch");
    expect(html).toContain("handleGraphStageClick");
    expect(html).toContain("resetGraphSelection");
    expect(html).toContain("renderGraphSurface");
    expect(html).toContain("renderGraphNavigator");
    expect(html).toContain("handleGraphNavigatorAction");
    expect(html).toContain("graphEdgesForMode");
    expect(html).toContain("renderGraphOverview");
    expect(html).toContain("renderGraphClusters");
    expect(html).toContain("graphClusters");
    expect(html).toContain("toggleGraphCluster");
    expect(html).toContain("renderOverviewNode");
    expect(html).toContain("overviewNodeMeta");
    expect(html).toContain("graphEdgeMode");
    expect(html).toContain("graphViewMode");
    expect(html).toContain('"topic-focus"');
    expect(html).toContain('"memory-focus"');
    expect(html).toContain('"overview"');
    expect(html).toContain("renderGraphSearchResults");
    expect(html).toContain("data-graph-search-result-id");
    expect(html).toContain("search-match");
    expect(html).toContain("search-parent");
    expect(html).toContain("search-active");
    expect(html).toContain("hidden by filters");
    expect(html).toContain("accent-rail");
    expect(html).toContain("table-browser-select");
    expect(html).toContain("data-table-page-size");
    expect(html).toContain("data-page-action");
    expect(html).toContain("expandedCell");
    expect(html).toContain("db-cell-expanded");
    expect(html).toContain("mg_topic_nodes");
    expect(html).toContain("mg_memory_nodes");
    expect(html).toContain("mg_message_buffer");
    expect(html).toContain("mg_sessions");
    expect(html).toContain("mg_session_ingest_state");
    expect(html).toContain("data-db-cell-column");
    expect(html).not.toContain("cell-inspector");
    expect(html).toContain("details-section");
    expect(html).toContain('state.activeTab === "tables" || state.activeTab === "preview"');
    expect(html).toContain("single-pane");
    expect(html).toContain("elements.detailsSection.hidden = singlePane");
    expect(html).toContain('elements.detailsSection.style.display = singlePane ? "none" : ""');
    expect(html).toContain("preview-query");
    expect(html).toContain("preview-mode");
    expect(html).toContain("Run preview");
    expect(html).toContain("Copy prompt");
    expect(html).toContain("prompt-preview-output");
    expect(html).toContain("tokenUsageText");
    expect(html).toContain('"/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/preview"');
    expect(html).not.toContain("Prompt Preview workspace shell");
    expect(html).not.toContain("read-only table UI lands in Phase 4");
    expect(html).toContain("Memory type");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("expandedMemoriesTopicId");
    expect(html).toContain("Show memories");
    expect(html).toContain("Hide memories");
    expect(html).toContain('aria-expanded="');
    expect(html).toContain("connected-memory-window");
    expect(html).toContain("max-height: 222px");
    expect(html).toContain("connected-memory-row");
    expect(html).toContain("connected-memory-value");
    expect(html).toContain('if (!expanded || memories.length === 0) return summary');
    expect(html).toContain("Suppress topic");
    expect(html).toContain("sessionDisplayLabel");
    expect(html).toContain("filteredSessions");
    expect(html).toContain("startSessionTitleEdit");
    expect(html).toContain("saveSessionTitleEdit");
    expect(html).toContain("data-session-title-save");
    expect(html).toContain("Enter to save / Esc to cancel");
    expect(html).toContain("No sessions match this search.");
    expect(html).toContain('data-lifecycle-action="');
    expect(html).toContain("Graft to session");
    expect(html).toContain("Review graft");
    expect(html).toContain("Review graft");
    expect(html).toContain("Source topic");
    expect(html).toContain("graft-memory-row");
    expect(html).toContain("graft-destination");
    expect(html).toContain("Already grafted · skip");
    expect(html).toContain("independent copy");
    expect(html).toContain('"Graft to " + numberText(state.graft.preview.targets.length)');
    expect(html).toContain("Remove graft");
    expect(html).toContain('action === "preview" ? "/preview" : ""');
    expect(html).toContain('data-graft-action="navigate"');
    expect(html).toContain("max-height: 188px");
    expect(html).toContain("overflow-y: auto");
    expect(html).toContain("graftMemoryTitle(memory)");
    expect(html).toContain("if (state.graft.result)");
    expect(html).toContain('data-graft-action="done"');
    expect(html).toContain("No topics copied");
    expect(html).toContain("Graft completed with issues");
    expect(html).toContain('fetchJson(url, { method: "POST" })');
    expect(html).not.toContain("Restore topic");
    expect(html).not.toContain("Forget memory");
    expect(html).not.toContain("This lifecycle action cannot be undone in Studio.");
    expect(html).toContain("preserveSelection: true");
    expect(html).toContain('aria-live="polite"');
  });
});

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.text(),
  };
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>\n([\s\S]*)\n[ ]{4}<\/script>/);
  if (!match) throw new Error("Studio inline script was not found.");
  return match[1] ?? "";
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
