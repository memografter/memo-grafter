export interface StudioFrontendState {
  databaseStatus: "connected" | "error";
  sessionCount: number;
  studioUrl: string;
  previewStatus?: {
    available: boolean;
    reason?: string;
  };
  message?: string;
}

export function renderStudioHtml(state: StudioFrontendState): string {
  const serializedState = JSON.stringify(state).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MemoGrafter Studio</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --bg: #f5f7fb;
        --surface: #ffffff;
        --surface-muted: #f8fafc;
        --surface-raised: #ffffff;
        --surface-code: #111827;
        --text: #17202d;
        --text-strong: #111827;
        --text-muted: #607086;
        --text-subtle: #75849a;
        --border: #d8dee9;
        --border-muted: #e4e8f0;
        --accent: #315f9f;
        --accent-strong: #1d4ed8;
        --accent-soft: #eef6ff;
        --success: #16714a;
        --success-soft: #edf8f1;
        --warning: #9a5b12;
        --warning-soft: #fff7ed;
        --danger: #a52f2a;
        --danger-soft: #fff1f0;
        --topic-surface: #f0fdfa;
        --topic-border: #99d8cf;
        --memory-surface: #fff7ed;
        --memory-border: #f2c38b;
        --shadow-sm: 0 1px 2px rgba(17, 24, 39, 0.05);
        --shadow-md: 0 10px 24px rgba(17, 24, 39, 0.08);
        --focus-ring: rgba(61, 111, 182, 0.28);
        background: var(--bg);
        color: var(--text);
      }

      :root[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0d1117;
        --surface: #111827;
        --surface-muted: #162033;
        --surface-raised: #172033;
        --surface-code: #070b12;
        --text: #dbe6f3;
        --text-strong: #f8fafc;
        --text-muted: #9aa8bb;
        --text-subtle: #7f8da3;
        --border: #2a3547;
        --border-muted: #243044;
        --accent: #7aa7e8;
        --accent-strong: #93c5fd;
        --accent-soft: #12223a;
        --success: #4ade80;
        --success-soft: #10251b;
        --warning: #fbbf24;
        --warning-soft: #2a1e0d;
        --danger: #f87171;
        --danger-soft: #2a1214;
        --topic-surface: #092523;
        --topic-border: #1f6f67;
        --memory-surface: #291b0d;
        --memory-border: #8a5b1f;
        --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
        --shadow-md: 0 16px 36px rgba(0, 0, 0, 0.36);
        --focus-ring: rgba(147, 197, 253, 0.35);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
      }

      button,
      input,
      select,
      textarea {
        font: inherit;
      }

      button {
        cursor: pointer;
      }

      button,
      input,
      select,
      textarea,
      [tabindex="0"] {
        transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, opacity 140ms ease, stroke-width 140ms ease;
      }

      button:focus-visible,
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible,
      [tabindex="0"]:focus-visible {
        outline: 3px solid rgba(61, 111, 182, 0.28);
        outline-offset: 2px;
      }

      .app-shell {
        display: grid;
        grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
        min-height: 100vh;
      }

      .sidebar {
        background: #ffffff;
        border-right: 1px solid #d8dee9;
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }

      .sidebar-header {
        border-bottom: 1px solid #e4e8f0;
        padding: 20px;
      }

      .brand-row {
        align-items: center;
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .brand {
        font-size: 18px;
        font-weight: 750;
        margin: 0;
      }

      .status-pill {
        align-items: center;
        border: 1px solid #b9d8c8;
        border-radius: 999px;
        color: #16714a;
        display: inline-flex;
        font-size: 12px;
        font-weight: 650;
        gap: 7px;
        padding: 5px 9px;
        white-space: nowrap;
      }

      .status-dot {
        background: #18a66c;
        border-radius: 999px;
        height: 8px;
        width: 8px;
      }

      .studio-url {
        color: #617086;
        font-size: 12px;
        margin: 10px 0 0;
        overflow-wrap: anywhere;
      }

      .session-toolbar,
      .graph-toolbar {
        align-items: center;
        display: flex;
        gap: 10px;
        justify-content: space-between;
      }

      .session-toolbar {
        padding: 16px 20px 10px;
      }

      .session-search {
        padding: 0 20px 12px;
      }

      .section-title {
        font-size: 13px;
        font-weight: 750;
        margin: 0;
        text-transform: uppercase;
      }

      .icon-button,
      .primary-button {
        align-items: center;
        border: 1px solid #c9d2e2;
        border-radius: 7px;
        background: #ffffff;
        color: #253246;
        display: inline-flex;
        font-weight: 650;
        gap: 7px;
        min-height: 34px;
        padding: 7px 10px;
      }

      .icon-button:hover,
      .primary-button:hover {
        border-color: #8fa4c4;
        background: #f8fbff;
      }

      .session-list {
        display: grid;
        gap: 8px;
        list-style: none;
        margin: 0;
        overflow: auto;
        padding: 0 12px 20px;
      }

      .session-button {
        background: #ffffff;
        border: 1px solid #e0e5ee;
        border-radius: 8px;
        color: inherit;
        display: grid;
        gap: 8px;
        padding: 12px;
        text-align: left;
        width: 100%;
      }

      .session-button[aria-current="true"] {
        border-color: #3d6fb6;
        box-shadow: inset 3px 0 0 #3d6fb6;
      }

      .session-id {
        font-size: 13px;
        font-weight: 750;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .session-label {
        font-size: 13px;
        font-weight: 800;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .session-secondary {
        color: #607086;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        overflow-wrap: anywhere;
      }

      .session-meta {
        color: #607086;
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 7px;
      }

      .badge {
        background: #eef3fa;
        border: 1px solid #dbe3ef;
        border-radius: 999px;
        color: #45556b;
        display: inline-flex;
        font-size: 12px;
        font-weight: 650;
        padding: 3px 7px;
      }

      .main {
        min-width: 0;
        padding: 18px 22px 22px;
      }

      .topbar {
        align-items: flex-start;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow-sm);
        display: flex;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
        padding: 14px;
      }

      .topbar-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      h1 {
        font-size: 23px;
        line-height: 1.2;
        margin: 0 0 6px;
      }

      .title-editor {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 6px;
      }

      .title-button {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        color: #17202d;
        font-size: 23px;
        font-weight: 750;
        line-height: 1.2;
        min-height: 34px;
        padding: 2px 4px;
        text-align: left;
      }

      .title-button:not(:disabled):hover {
        background: #eef3fa;
        border-color: #d5dfed;
      }

      .title-input {
        background: #ffffff;
        border: 1px solid #3d6fb6;
        border-radius: 7px;
        color: #17202d;
        font-size: 20px;
        font-weight: 750;
        min-height: 36px;
        min-width: min(560px, 100%);
        padding: 4px 8px;
      }

      .title-save {
        min-width: 36px;
        justify-content: center;
      }

      .title-status {
        color: #66758a;
        font-size: 12px;
      }

      .subtle {
        color: #66758a;
        font-size: 13px;
        line-height: 1.45;
        margin: 0;
      }

      .filters {
        align-items: end;
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(5, minmax(130px, 1fr));
        margin-bottom: 16px;
      }

      .graph-search {
        align-items: end;
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(220px, 1fr) auto auto;
        margin-bottom: 12px;
      }

      .graph-search-count {
        color: #66758a;
        font-size: 12px;
        white-space: nowrap;
      }

      .graph-search-results {
        border-bottom: 1px solid #e4e8f0;
        display: grid;
        gap: 8px;
        padding: 10px 12px;
      }

      .graph-search-result-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .graph-search-result {
        background: #ffffff;
        border: 1px solid #dbe3ef;
        border-radius: 7px;
        color: #253246;
        display: inline-flex;
        gap: 6px;
        max-width: 340px;
        min-height: 30px;
        padding: 5px 8px;
        text-align: left;
      }

      .graph-search-result.active {
        border-color: #3d6fb6;
        box-shadow: 0 0 0 2px rgba(61, 111, 182, 0.16);
      }

      .workspace-tabs {
        align-items: center;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        display: flex;
        gap: 4px;
        margin-bottom: 16px;
        padding: 4px;
      }

      .tab-button {
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: #55657b;
        font-weight: 750;
        min-height: 34px;
        padding: 7px 12px;
      }

      .tab-button[aria-selected="true"] {
        background: var(--accent-soft);
        color: #1f2a3a;
      }

      .workspace-placeholder {
        color: #66758a;
        display: grid;
        gap: 10px;
        min-height: 508px;
        place-items: center;
        text-align: center;
      }

      .placeholder-card {
        display: grid;
        gap: 8px;
        max-width: 560px;
      }

      .table-stack {
        display: grid;
        gap: 16px;
        padding: 14px;
      }

      .data-table-section {
        border: 1px solid #e0e5ee;
        border-radius: 8px;
        overflow: hidden;
      }

      .data-table-heading {
        align-items: center;
        background: #f8fbff;
        border-bottom: 1px solid #e0e5ee;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
      }

      .data-table-wrap {
        max-height: 320px;
        overflow: auto;
      }

      .data-table {
        border-collapse: collapse;
        font-size: 12px;
        min-width: 860px;
        width: 100%;
      }

      .data-table th,
      .data-table td {
        border-bottom: 1px solid #edf1f6;
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
      }

      .data-table th {
        background: #ffffff;
        color: #53647a;
        font-size: 11px;
        font-weight: 800;
        position: sticky;
        text-transform: uppercase;
        top: 0;
        z-index: 1;
      }

      .data-table tr {
        cursor: pointer;
      }

      .data-table tr:hover td {
        background: #f8fbff;
      }

      .data-table tr:focus-visible td {
        background: #eef6ff;
        box-shadow: inset 0 0 0 2px #3d6fb6;
      }

      .data-table tr.selected td {
        background: #eef6ff;
      }

      .table-cell-clip {
        display: inline-block;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: top;
        white-space: nowrap;
      }

      .table-empty {
        color: #66758a;
        font-size: 13px;
        padding: 16px;
      }

      .content-grid.single-pane {
        grid-template-columns: minmax(0, 1fr);
      }

      .table-browser {
        display: grid;
        gap: 14px;
        padding: 14px;
      }

      .table-browser-toolbar,
      .pagination-controls,
      .cell-meta {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .table-browser-toolbar {
        justify-content: space-between;
      }

      .table-browser-controls {
        align-items: end;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .table-select {
        min-width: 260px;
      }

      .db-table {
        border-collapse: collapse;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        min-width: 920px;
        width: 100%;
      }

      .db-table th,
      .db-table td {
        border-bottom: 1px solid #edf1f6;
        max-width: 340px;
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
      }

      .db-table th {
        background: #ffffff;
        color: #53647a;
        font-size: 11px;
        font-weight: 800;
        position: sticky;
        text-transform: uppercase;
        top: 0;
        z-index: 1;
      }

      .db-cell {
        cursor: pointer;
      }

      .db-cell:hover {
        background: #f8fbff;
      }

      .db-cell:focus-visible {
        background: #eef6ff;
        box-shadow: inset 0 0 0 2px #3d6fb6;
      }

      .db-cell.selected {
        background: #eef6ff;
        box-shadow: inset 0 0 0 2px #3d6fb6;
      }

      .db-cell-expanded {
        display: block;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        line-height: 1.5;
        max-height: 260px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .preview-workspace {
        display: grid;
        gap: 14px;
        padding: 14px;
      }

      .preview-form {
        display: grid;
        gap: 12px;
      }

      .preview-form textarea {
        min-height: 92px;
        resize: vertical;
      }

      .preview-actions,
      .preview-summary {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .graft-panel { display: grid; gap: 10px; margin-top: 12px; }
      .graft-target-list { border: 1px solid #d8dee9; border-radius: 8px; display: grid; gap: 8px; max-height: 188px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 10px; }
      .graft-target { align-items: flex-start; display: flex; gap: 8px; min-height: 52px; }
      .graft-review { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .graft-review-header { background: var(--surface-muted); border-bottom: 1px solid var(--border-muted); display: grid; gap: 3px; padding: 12px 14px; }
      .graft-review-title { color: var(--text-strong); font-size: 15px; font-weight: 800; }
      .graft-review-subtitle { color: var(--text-muted); font-size: 12px; line-height: 1.4; }
      .graft-review-body { display: grid; gap: 0; padding: 0 14px; }
      .graft-review-section { border-bottom: 1px solid var(--border-muted); display: grid; gap: 9px; padding: 13px 0; }
      .graft-review-section:last-child { border-bottom: 0; }
      .graft-eyebrow { color: var(--text-muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .graft-topic-title { color: var(--text-strong); font-size: 15px; font-weight: 800; line-height: 1.35; }
      .graft-counts { display: flex; flex-wrap: wrap; gap: 7px; }
      .graft-count { background: var(--accent-soft); border: 1px solid var(--border-muted); border-radius: 999px; color: var(--text); font-size: 11px; font-weight: 750; padding: 4px 8px; }
      .graft-count.omitted { background: var(--surface-muted); color: var(--text-muted); }
      .graft-memory-list { display: grid; gap: 6px; max-height: 180px; overflow-y: auto; padding-right: 2px; }
      .graft-memory-row { align-items: center; background: var(--surface-muted); border: 1px solid var(--border-muted); border-radius: 7px; color: var(--text); display: flex; font-size: 12px; gap: 8px; line-height: 1.35; padding: 7px 9px; }
      .graft-memory-check { color: var(--success); font-weight: 900; }
      .graft-destinations { display: grid; gap: 7px; }
      .graft-destination { align-items: center; background: var(--surface-muted); border: 1px solid var(--border-muted); border-radius: 7px; display: flex; gap: 8px; justify-content: space-between; padding: 8px 9px; }
      .graft-destination-name { color: var(--text); font-size: 12px; font-weight: 750; overflow-wrap: anywhere; }
      .graft-status { border-radius: 999px; flex: 0 0 auto; font-size: 10px; font-weight: 800; padding: 3px 7px; }
      .graft-status.ready { background: var(--success-soft); color: var(--success); }
      .graft-status.skip { background: var(--warning-soft); color: var(--warning); }
      .graft-copy-note { background: var(--accent-soft); border-radius: 7px; color: var(--text-muted); font-size: 11px; line-height: 1.45; padding: 8px 9px; }
      .graft-footer { background: var(--surface); border-top: 1px solid var(--border-muted); justify-content: flex-end; padding-top: 10px; position: sticky; bottom: 0; }

      .preview-result {
        border: 1px solid #d8dee9;
        border-radius: 8px;
        overflow: hidden;
      }

      .preview-result-header {
        align-items: center;
        background: #f8fbff;
        border-bottom: 1px solid #e0e5ee;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: space-between;
        padding: 10px 12px;
      }

      .token-meter.warning {
        background: #fff7ed;
        border-color: #fed7aa;
        color: #9a3412;
      }

      .prompt-preview-output {
        background: #111827;
        color: #f8fafc;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        margin: 0;
        max-height: 520px;
        min-height: 220px;
        overflow: auto;
        padding: 14px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .field {
        display: grid;
        gap: 5px;
      }

      .field label {
        color: #58687e;
        font-size: 12px;
        font-weight: 700;
      }

      .field input,
      .field select {
        background: #ffffff;
        border: 1px solid #cfd7e6;
        border-radius: 7px;
        color: #1c2737;
        min-height: 36px;
        padding: 7px 9px;
        width: 100%;
      }

      .content-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr) 300px;
      }

      .panel {
        background: #ffffff;
        border: 1px solid #d8dee9;
        border-radius: 8px;
        min-width: 0;
      }

      .graph-panel {
        min-height: 560px;
        overflow: hidden;
      }

      .panel-header {
        align-items: center;
        border-bottom: 1px solid #e4e8f0;
        display: flex;
        justify-content: space-between;
        gap: 12px;
        min-height: 50px;
        padding: 12px 14px;
      }

      .panel-title {
        font-size: 14px;
        font-weight: 750;
        margin: 0;
      }

      .graph-stage {
        min-height: 508px;
        overflow: auto;
      }

      .empty-state,
      .error-state,
      .loading-state {
        color: #66758a;
        display: grid;
        min-height: 508px;
        place-items: center;
        text-align: center;
      }

      .error-state {
        color: #9a3412;
      }

      .graph-svg {
        display: block;
        min-width: 980px;
      }

      .graph-overview {
        display: grid;
        gap: 12px;
        padding: 14px;
      }

      .graph-overview-header {
        align-items: center;
        display: flex;
        gap: 10px;
        justify-content: space-between;
      }

      .graph-overview-title {
        color: #1c2737;
        font-size: 13px;
        font-weight: 800;
      }

      .graph-overview-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }

      .overview-node {
        align-items: stretch;
        background: #ffffff;
        border: 1px solid #dbe3ef;
        border-radius: 8px;
        color: #1f2a3a;
        display: grid;
        grid-template-columns: 7px minmax(0, 1fr);
        min-height: 116px;
        overflow: hidden;
        padding: 0;
        text-align: left;
      }

      .overview-node.topic {
        background: #f0fdfa;
        border-color: #99d8cf;
      }

      .overview-node.memory {
        background: #fff7ed;
        border-color: #f2c38b;
      }

      .overview-node:hover,
      .overview-node.selected,
      .overview-node.hovered {
        border-color: #1d4ed8;
        box-shadow: 0 0 0 2px rgba(29, 78, 216, 0.12);
      }

      .overview-node.search-match {
        border-color: #d97706;
        box-shadow: 0 0 0 2px rgba(217, 119, 6, 0.14);
      }

      .overview-node.search-parent {
        border-color: #8b5cf6;
      }

      .overview-node.search-active {
        border-color: #dc2626;
        box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.16);
      }

      .overview-node:focus-visible {
        outline: 3px solid rgba(37, 99, 235, 0.35);
        outline-offset: 2px;
      }

      .overview-accent.topic {
        background: #0f766e;
      }

      .overview-accent.memory {
        background: #b45309;
      }

      .overview-node-body {
        display: grid;
        gap: 7px;
        padding: 10px 12px;
      }

      .overview-node-topline {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: space-between;
      }

      .overview-node-kind {
        color: #617086;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
      }

      .overview-node-title {
        font-size: 14px;
        font-weight: 800;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .overview-node-summary {
        color: #43536a;
        font-size: 12px;
        line-height: 1.35;
      }

      .overview-node-meta {
        color: #617086;
        display: flex;
        flex-wrap: wrap;
        font-size: 11px;
        gap: 7px;
      }

      .graph-navigator {
        align-items: center;
        border-bottom: 1px solid #e4e8f0;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: space-between;
        padding: 10px 14px;
      }

      .graph-nav-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }

      .graph-cluster-list {
        display: grid;
        gap: 12px;
      }

      .graph-cluster {
        border: 1px solid #dbe3ef;
        border-radius: 8px;
        overflow: hidden;
      }

      .graph-cluster-header {
        align-items: center;
        background: #f8fafc;
        border: 0;
        border-bottom: 1px solid #dbe3ef;
        color: #1f2a3a;
        display: flex;
        justify-content: space-between;
        padding: 10px 12px;
        text-align: left;
        width: 100%;
      }

      .graph-cluster-title {
        font-size: 13px;
        font-weight: 800;
      }

      .graph-cluster-body {
        padding: 10px;
      }

      .node-card .node-surface {
        fill: #ffffff;
        filter: drop-shadow(0 8px 18px rgba(17, 24, 39, 0.08));
        stroke: #cad3e2;
        stroke-width: 1.5;
      }

      .node-card.topic .node-surface {
        fill: #f0fdfa;
        stroke: #99d8cf;
      }

      .node-card.memory .node-surface {
        fill: #fff7ed;
        stroke: #f2c38b;
      }

      .node-card.selected .node-surface,
      .node-card.hovered .node-surface {
        stroke: #1d4ed8;
        stroke-width: 2.4;
      }

      .node-card.search-match .node-surface {
        stroke: #d97706;
        stroke-width: 2.3;
      }

      .node-card.search-parent .node-surface {
        stroke: #8b5cf6;
        stroke-width: 2;
      }

      .node-card.search-active .node-surface {
        stroke: #dc2626;
        stroke-width: 3;
      }

      .node-card.dimmed {
        opacity: 0.34;
      }

      .node-card .accent-rail.topic {
        fill: #0f766e;
      }

      .node-card .accent-rail.memory {
        fill: #b45309;
      }

      .node-card text {
        fill: #1f2a3a;
        font-size: 12px;
        pointer-events: none;
      }

      .node-card .node-kind {
        fill: #617086;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .node-card .node-title {
        font-size: 13px;
        font-weight: 800;
      }

      .node-card .node-meta {
        fill: #617086;
        font-size: 10px;
        font-weight: 650;
      }

      .node-card .badge-text {
        fill: #ffffff;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
      }

      .status-badge.active {
        fill: #0f766e;
      }

      .status-badge.suppressed,
      .status-badge.forgotten {
        fill: #64748b;
      }

      .status-badge.decayed,
      .status-badge.superseded {
        fill: #b45309;
      }

      .status-badge.conflicting {
        fill: #b42318;
      }

      .edge-line {
        fill: none;
        marker-end: url(#graph-arrow-topic);
        opacity: 0.82;
        stroke: #8ea0b8;
        stroke-linecap: round;
        stroke-width: 1.8;
      }

      .edge-line.memory {
        marker-end: url(#graph-arrow-memory);
        stroke: #b89a71;
        stroke-dasharray: 5 5;
      }

      .edge-line.attachment {
        marker-end: url(#graph-arrow-attachment);
        opacity: 0.55;
        stroke: #94a3b8;
        stroke-dasharray: 2 6;
      }

      .edge-line.highlighted {
        opacity: 1;
        stroke-width: 2.8;
      }

      .edge-line.dimmed {
        opacity: 0.14;
      }

      .node-card:focus-visible .node-surface {
        outline: none;
        stroke: #2563eb;
        stroke-width: 3;
      }

      .details {
        display: grid;
        gap: 16px;
        padding: 14px;
      }

      .detail-section {
        display: grid;
        gap: 10px;
      }

      .detail-section + .detail-section {
        border-top: 1px solid #dbe2eb;
        padding-top: 14px;
      }

      .detail-section-title {
        color: #34445a;
        font-size: 12px;
        font-weight: 800;
        margin: 0;
      }

      .detail-row {
        display: grid;
        gap: 4px;
      }

      .detail-label {
        color: #627188;
        font-size: 11px;
        font-weight: 750;
        text-transform: uppercase;
      }

      .detail-value {
        color: #1f2a3a;
        font-size: 13px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }

      .detail-list {
        display: grid;
        gap: 6px;
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .connected-memory-summary { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
      .connected-memory-count { color: var(--text-muted); font-size: 12px; font-weight: 700; }
      .connected-memory-window { display: grid; gap: 7px; max-height: 222px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
      .connected-memory-row { align-items: center; background: var(--surface-muted); border: 1px solid var(--border-muted); border-radius: 8px; color: inherit; display: grid; gap: 4px; grid-template-columns: minmax(0, 1fr) auto; min-height: 68px; padding: 9px 10px; text-align: left; width: 100%; }
      .connected-memory-row:hover { background: var(--accent-soft); border-color: var(--accent); }
      .connected-memory-copy { display: grid; gap: 3px; min-width: 0; }
      .connected-memory-title { color: var(--text-strong); font-size: 12px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .connected-memory-value { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--text-muted); display: -webkit-box; font-size: 11px; line-height: 1.35; overflow: hidden; }
      .connected-memory-chevron { color: var(--text-muted); font-size: 16px; }

      .detail-link {
        background: transparent;
        border: 0;
        color: #1d4ed8;
        cursor: pointer;
        font: inherit;
        padding: 0;
        text-align: left;
      }

      .detail-link:hover {
        text-decoration: underline;
      }

      .detail-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .danger-button {
        background: #fff;
        border: 1px solid #c2413b;
        color: #a52f2a;
      }

      .action-status {
        border-left: 3px solid;
        font-size: 13px;
        line-height: 1.45;
        padding: 8px 10px;
      }

      .action-status.success {
        background: #edf8f1;
        border-color: #27814c;
        color: #176238;
      }

      .action-status.error {
        background: #fff1f0;
        border-color: #c2413b;
        color: #922d28;
      }

      .action-status.warning {
        background: #fff7ed;
        border-color: #d97706;
        color: #9a5b12;
      }

      .tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .summary-strip {
        color: #617086;
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 8px;
      }

      /* Studio visual system */
      body {
        background: var(--bg);
        color: var(--text);
      }

      .sidebar,
      .panel,
      .session-button,
      .graph-search-result,
      .icon-button,
      .primary-button,
      .field input,
      .field select,
      .field textarea,
      .title-input {
        background: var(--surface);
        border-color: var(--border);
        color: var(--text);
      }

      .main {
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--surface-muted) 80%, transparent), transparent 320px),
          var(--bg);
      }

      .sidebar-header,
      .workspace-tabs,
      .panel-header,
      .graph-search-results,
      .graph-navigator,
      .detail-section + .detail-section,
      .preview-result-header,
      .data-table-heading,
      .graph-cluster-header {
        border-color: var(--border-muted);
      }

      .sidebar,
      .panel,
      .data-table-section,
      .preview-result,
      .graph-cluster,
      .workspace-tabs,
      .topbar {
        box-shadow: var(--shadow-sm);
      }

      .brand,
      .title-button,
      .panel-title,
      .graph-overview-title,
      .detail-value,
      .overview-node-title,
      .tab-button[aria-selected="true"] {
        color: var(--text-strong);
      }

      .studio-url,
      .subtle,
      .session-meta,
      .session-secondary,
      .graph-search-count,
      .summary-strip,
      .overview-node-meta,
      .overview-node-kind,
      .overview-node-summary,
      .detail-label,
      .title-status,
      .table-empty,
      .empty-state,
      .loading-state {
        color: var(--text-muted);
      }

      .title-button:not(:disabled):hover,
      .icon-button:hover,
      .primary-button:hover,
      .tab-button:hover,
      .session-button:hover,
      .db-cell:hover,
      .data-table tr:hover td {
        background: var(--surface-muted);
        border-color: var(--accent);
      }

      .primary-button,
      .session-button[aria-current="true"],
      .tab-button[aria-selected="true"] {
        border-color: var(--accent);
      }

      .session-button[aria-current="true"] {
        box-shadow: inset 3px 0 0 var(--accent);
      }

      .tab-button[aria-selected="true"] {
        border-bottom-color: var(--accent);
      }

      .badge {
        background: var(--surface-muted);
        border-color: var(--border);
        color: var(--text-muted);
      }

      .status-pill {
        background: var(--success-soft);
        border-color: color-mix(in srgb, var(--success) 45%, var(--border));
        color: var(--success);
      }

      .field label,
      .detail-section-title,
      .db-table th,
      .data-table th {
        color: var(--text-muted);
      }

      .session-list {
        padding-top: 2px;
      }

      .session-button {
        min-height: 86px;
      }

      .table-browser,
      .preview-workspace,
      .details {
        background: var(--surface);
      }

      .db-table th,
      .data-table th,
      .data-table-heading,
      .preview-result-header,
      .graph-cluster-header {
        background: var(--surface-muted);
      }

      .db-table td,
      .db-table th,
      .data-table td,
      .data-table th {
        border-color: var(--border-muted);
      }

      .db-table tbody tr:nth-child(even) td,
      .data-table tbody tr:nth-child(even) td {
        background: color-mix(in srgb, var(--surface-muted) 44%, transparent);
      }

      .db-cell.selected,
      .db-cell:focus-visible,
      .data-table tr.selected td,
      .data-table tr:focus-visible td {
        background: var(--accent-soft);
        box-shadow: inset 0 0 0 2px var(--accent);
      }

      .overview-node,
      .node-card .node-surface {
        background: var(--surface);
        color: var(--text);
      }

      .overview-node.topic,
      .node-card.topic .node-surface {
        background: var(--topic-surface);
        border-color: var(--topic-border);
        fill: var(--topic-surface);
        stroke: var(--topic-border);
      }

      .overview-node.memory,
      .node-card.memory .node-surface {
        background: var(--memory-surface);
        border-color: var(--memory-border);
        fill: var(--memory-surface);
        stroke: var(--memory-border);
      }

      .node-card .node-surface {
        fill: var(--surface);
        stroke: var(--border);
      }

      .node-card text {
        fill: var(--text);
      }

      .node-card .node-kind,
      .node-card .node-meta {
        fill: var(--text-muted);
      }

      .overview-node:hover,
      .overview-node.selected,
      .overview-node.hovered,
      .node-card.selected .node-surface,
      .node-card.hovered .node-surface {
        border-color: var(--accent-strong);
        stroke: var(--accent-strong);
      }

      .prompt-preview-output {
        background: var(--surface-code);
        color: #f8fafc;
        border-top: 1px solid var(--border-muted);
      }

      .preview-form textarea {
        line-height: 1.45;
      }

      .danger-button {
        background: var(--danger-soft);
        border-color: var(--danger);
        color: var(--danger);
      }

      .action-status.success {
        background: var(--success-soft);
        border-color: var(--success);
        color: var(--success);
      }

      .action-status.error,
      .error-state {
        background: var(--danger-soft);
        border-color: var(--danger);
        color: var(--danger);
      }

      .action-status.warning {
        background: var(--warning-soft);
        border-color: var(--warning);
        color: var(--warning);
      }

      .token-meter.warning {
        background: var(--warning-soft);
        border-color: var(--warning);
        color: var(--warning);
      }

      .hidden {
        display: none;
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          scroll-behavior: auto !important;
          transition-duration: 0.001ms !important;
        }
      }

      @media (max-width: 980px) {
        .app-shell,
        .content-grid {
          grid-template-columns: 1fr;
        }

        .sidebar {
          min-height: auto;
        }

        .filters {
          grid-template-columns: 1fr 1fr;
        }

        .graph-search {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        .filters,
        .topbar {
          grid-template-columns: 1fr;
          display: grid;
        }

        .main {
          padding: 14px;
        }
      }
    </style>
  </head>
  <body>
    <div class="app-shell" id="studio-app">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="brand-row">
            <p class="brand">MemoGrafter Studio</p>
            <span class="status-pill"><span class="status-dot"></span><span id="database-status"></span></span>
          </div>
          <p class="studio-url" id="studio-url"></p>
        </div>
        <div class="session-toolbar">
          <p class="section-title">Sessions</p>
          <button class="icon-button" id="refresh-sessions" type="button" title="Refresh sessions">Refresh</button>
        </div>
        <div class="session-search field">
          <label for="session-search">Search sessions</label>
          <input id="session-search" type="search" placeholder="Label or session id">
        </div>
        <ul class="session-list" id="session-list" aria-label="Sessions"></ul>
      </aside>
      <main class="main">
        <div class="topbar">
          <div>
            <div class="title-editor" id="title-editor">
              <button class="title-button" id="page-title" type="button" disabled>Select a session</button>
            </div>
            <p class="subtle" id="page-subtitle">Graph data loads only after you choose a session.</p>
          </div>
          <div class="topbar-actions">
            <button class="icon-button" id="theme-toggle" type="button" aria-pressed="false">Dark mode</button>
            <button class="primary-button" id="refresh-graph" type="button" disabled>Refresh graph</button>
          </div>
        </div>

        <div class="workspace-tabs" role="tablist" aria-label="Session workspace tabs">
          <button class="tab-button" id="tab-graph" type="button" role="tab" aria-controls="workspace-panel" aria-selected="true" data-tab="graph">Graph</button>
          <button class="tab-button" id="tab-tables" type="button" role="tab" aria-controls="workspace-panel" aria-selected="false" data-tab="tables">Tables</button>
          <button class="tab-button" id="tab-preview" type="button" role="tab" aria-controls="workspace-panel" aria-selected="false" data-tab="preview">Invoke Preview</button>
        </div>

        <div class="graph-search" id="graph-search" aria-label="Graph search">
          <div class="field">
            <label for="graph-search-input">Graph search</label>
            <input id="graph-search-input" type="search" placeholder="Search topics or memories">
          </div>
          <span class="graph-search-count" id="graph-search-count" aria-live="polite"></span>
          <button class="icon-button" id="graph-search-clear" type="button" disabled>Clear</button>
        </div>

        <div class="filters" id="graph-filters" aria-label="Graph filters">
          <div class="field">
            <label for="graph-view-mode">View</label>
            <select id="graph-view-mode">
              <option value="overview">Overview</option>
              <option value="clusters">Clusters</option>
            </select>
          </div>
          <div class="field">
            <label for="graph-edge-mode">Edges</label>
            <select id="graph-edge-mode">
              <option value="focused">Focused</option>
              <option value="hidden">Hidden</option>
              <option value="all">All</option>
            </select>
          </div>
          <div class="field">
            <label for="node-type-filter">Node type</label>
            <select id="node-type-filter">
              <option value="all">All nodes</option>
              <option value="topics">Topics</option>
              <option value="memories">Memories</option>
            </select>
          </div>
          <div class="field">
            <label for="tag-filter">Tags</label>
            <input id="tag-filter" type="search" placeholder="project:memo-grafter">
          </div>
          <div class="field">
            <label for="lifecycle-filter">Lifecycle</label>
            <select id="lifecycle-filter">
              <option value="all">All states</option>
              <option value="active">Active</option>
              <option value="suppressed">Suppressed topics</option>
              <option value="forgotten">Forgotten memories</option>
              <option value="decayed">Decayed memories</option>
              <option value="superseded">Superseded memories</option>
              <option value="conflicting">Conflicting memories</option>
            </select>
          </div>
        </div>

        <div class="content-grid" id="content-grid">
          <section class="panel graph-panel" id="workspace-panel" role="tabpanel" aria-labelledby="tab-graph" aria-label="Session workspace">
            <div class="panel-header">
              <p class="panel-title" id="workspace-title">Graph</p>
              <div class="summary-strip" id="graph-summary" aria-live="polite"></div>
            </div>
            <div class="graph-stage" id="graph-stage">
              <div class="empty-state" role="status">Choose a session to load its memory graph.</div>
            </div>
          </section>
          <section class="panel" id="details-section" aria-label="Selection details">
            <div class="panel-header">
              <p class="panel-title">Details</p>
            </div>
            <div class="details" id="details-panel">
              <p class="subtle">Select a node in the graph to inspect its metadata.</p>
            </div>
          </section>
        </div>
      </main>
    </div>
    <script type="application/json" id="studio-state">${serializedState}</script>
    <script>
      (function () {
        const initialState = JSON.parse(document.getElementById("studio-state").textContent);
        const state = {
          sessions: [],
          sessionSearchQuery: "",
          editingSessionTitle: false,
          sessionTitleDraft: "",
          sessionTitleSaving: false,
          selectedSessionId: null,
          ingestionHealth: null,
          activeTab: "graph",
          graph: null,
          tables: null,
          selectedGraphNodeId: null,
          hoveredGraphNodeId: null,
          selectedEntity: null,
          tablesBrowser: {
            selectedTable: "mg_topic_nodes",
            page: 1,
            pageSize: 25,
            expandedCell: null
          },
          graphSearch: {
            query: "",
            activeMatchIndex: 0
          },
          graphViewMode: "overview",
          graphEdgeMode: "focused",
          collapsedGraphClusters: {},
          preview: {
            query: "",
            profile: "memo-grafter-agent",
            fleetMemoryMode: "local",
            subview: "messages",
            result: null,
            error: null,
            loading: false,
            requestId: 0,
            copied: false,
            completionLoading: false,
            completionResult: null
          },
          loadingSessions: false,
          loadingGraph: false,
          tabs: {
            graph: { loading: false, error: null, loadedAt: null },
            tables: { loading: false, error: null, loadedAt: null },
            preview: { loading: false, error: null, loadedAt: null }
          },
          actionPending: false,
          actionStatus: null,
          expandedMemoriesTopicId: null,
          graft: { topicId: null, targetSessionIds: [], preview: null, result: null, loading: false, error: null },
          error: null,
          filters: {
            nodeType: "all",
            tag: "",
            lifecycle: "all"
          }
        };

        const elements = {
          databaseStatus: document.getElementById("database-status"),
          studioUrl: document.getElementById("studio-url"),
          sessionList: document.getElementById("session-list"),
          sessionSearch: document.getElementById("session-search"),
          refreshSessions: document.getElementById("refresh-sessions"),
          refreshGraph: document.getElementById("refresh-graph"),
          themeToggle: document.getElementById("theme-toggle"),
          titleEditor: document.getElementById("title-editor"),
          pageTitle: document.getElementById("page-title"),
          pageSubtitle: document.getElementById("page-subtitle"),
          tabButtons: Array.from(document.querySelectorAll("[data-tab]")),
          graphSearch: document.getElementById("graph-search"),
          graphSearchInput: document.getElementById("graph-search-input"),
          graphSearchCount: document.getElementById("graph-search-count"),
          graphSearchClear: document.getElementById("graph-search-clear"),
          graphFilters: document.getElementById("graph-filters"),
          contentGrid: document.getElementById("content-grid"),
          workspaceTitle: document.getElementById("workspace-title"),
          graphStage: document.getElementById("graph-stage"),
          graphSummary: document.getElementById("graph-summary"),
          detailsSection: document.getElementById("details-section"),
          detailsPanel: document.getElementById("details-panel"),
          graphViewMode: document.getElementById("graph-view-mode"),
          graphEdgeMode: document.getElementById("graph-edge-mode"),
          nodeTypeFilter: document.getElementById("node-type-filter"),
          tagFilter: document.getElementById("tag-filter"),
          lifecycleFilter: document.getElementById("lifecycle-filter")
        };

        elements.databaseStatus.textContent = initialState.databaseStatus;
        elements.studioUrl.textContent = initialState.studioUrl;
        applyTheme(loadTheme());

        elements.refreshSessions.addEventListener("click", () => loadSessions());
        elements.themeToggle.addEventListener("click", () => {
          const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
          applyTheme(nextTheme);
          try {
            window.localStorage.setItem("memo-grafter-studio-theme", nextTheme);
          } catch {
            return;
          }
        });
        elements.sessionSearch.addEventListener("input", () => {
          state.sessionSearchQuery = elements.sessionSearch.value.trim().toLowerCase();
          renderSessions();
        });
        elements.pageTitle.addEventListener("click", () => startSessionTitleEdit());
        elements.refreshGraph.addEventListener("click", () => refreshActiveTab());
        elements.graphSearchInput.addEventListener("input", () => {
          state.graphSearch.query = elements.graphSearchInput.value.trim();
          state.graphSearch.activeMatchIndex = 0;
          renderGraph();
        });
        elements.graphSearchInput.addEventListener("keydown", handleGraphSearchKeydown);
        elements.graphSearchClear.addEventListener("click", () => clearGraphSearch());
        elements.graphStage.addEventListener("click", handleGraphStageClick);
        elements.graphViewMode.addEventListener("change", () => {
          state.graphViewMode = elements.graphViewMode.value;
          renderGraph();
        });
        elements.graphEdgeMode.addEventListener("change", () => {
          state.graphEdgeMode = elements.graphEdgeMode.value;
          renderGraph();
        });
        elements.tabButtons.forEach((button) => {
          button.addEventListener("click", () => selectTab(button.getAttribute("data-tab")));
          button.addEventListener("keydown", (event) => handleTabKeydown(event, button));
        });
        elements.nodeTypeFilter.addEventListener("change", () => {
          state.filters.nodeType = elements.nodeTypeFilter.value;
          renderGraph();
        });
        elements.tagFilter.addEventListener("input", () => {
          state.filters.tag = elements.tagFilter.value.trim().toLowerCase();
          renderGraph();
        });
        elements.lifecycleFilter.addEventListener("change", () => {
          state.filters.lifecycle = elements.lifecycleFilter.value;
          renderGraph();
        });

        loadSessions();

        async function loadSessions() {
          const hadSelectedSession = Boolean(state.selectedSessionId);
          let autoSelectSessionId = null;
          state.loadingSessions = true;
          renderSessions();
          try {
            const data = await fetchJson("/api/sessions");
            state.sessions = data.sessions || [];
            if (!hadSelectedSession && state.sessions.length > 0) {
              autoSelectSessionId = state.sessions[0].id;
            }
            state.error = null;
          } catch (error) {
            state.error = error.message || String(error);
          } finally {
            state.loadingSessions = false;
            renderSessions();
          }
          if (autoSelectSessionId) {
            void loadGraph(autoSelectSessionId);
          }
        }

        async function loadGraph(sessionId, options) {
          const preserveSelection = Boolean(options && options.preserveSelection && state.selectedSessionId === sessionId);
          const selectedGraphNodeId = preserveSelection ? state.selectedGraphNodeId : null;
          state.selectedSessionId = sessionId;
          state.ingestionHealth = null;
          state.activeTab = "graph";
          if (!preserveSelection) {
            state.graph = null;
            state.tables = null;
            state.selectedEntity = null;
            state.actionStatus = null;
            state.graphSearch = { query: "", activeMatchIndex: 0 };
            elements.graphSearchInput.value = "";
            state.graft = { topicId: null, targetSessionIds: [], preview: null, result: null, loading: false, error: null };
            state.expandedMemoriesTopicId = null;
          }
          state.selectedGraphNodeId = selectedGraphNodeId;
          state.loadingGraph = true;
          state.tabs.graph.loading = true;
          state.tabs.graph.error = null;
          state.error = null;
          renderSessions();
          renderWorkspace();
          renderHeader();
          try {
            const results = await Promise.all([
              fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/graph"),
              fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/ingestion-health")
            ]);
            state.graph = results[0];
            state.ingestionHealth = results[1];
            state.tabs.graph.loadedAt = new Date().toISOString();
            return true;
          } catch (error) {
            state.error = error.message || String(error);
            state.tabs.graph.error = state.error;
            return false;
          } finally {
            state.loadingGraph = false;
            state.tabs.graph.loading = false;
            renderSessions();
            renderHeader();
            renderWorkspace();
          }
        }

        async function loadTables(sessionId, options) {
          const force = Boolean(options && options.force);
          if (!force && state.tables && state.selectedSessionId === sessionId) {
            renderWorkspace();
            return true;
          }

          state.tabs.tables.loading = true;
          state.tabs.tables.error = null;
          renderWorkspace();

          try {
            state.tables = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/tables");
            state.tabs.tables.loadedAt = new Date().toISOString();
            return true;
          } catch (error) {
            state.tabs.tables.error = error.message || String(error);
            return false;
          } finally {
            state.tabs.tables.loading = false;
            renderWorkspace();
          }
        }

        function selectTab(tab) {
          if (!tab || !state.tabs[tab] || state.activeTab === tab) return;
          state.activeTab = tab;
          state.actionStatus = null;
          renderWorkspace();
          renderHeader();

          if (tab === "tables" && state.selectedSessionId) {
            void loadTables(state.selectedSessionId);
          }
        }

        function handleTabKeydown(event, button) {
          const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          const currentIndex = elements.tabButtons.indexOf(button);
          let nextIndex = currentIndex;
          if (event.key === "Home") nextIndex = 0;
          if (event.key === "End") nextIndex = elements.tabButtons.length - 1;
          if (event.key === "ArrowLeft") nextIndex = currentIndex <= 0 ? elements.tabButtons.length - 1 : currentIndex - 1;
          if (event.key === "ArrowRight") nextIndex = currentIndex >= elements.tabButtons.length - 1 ? 0 : currentIndex + 1;
          const nextButton = elements.tabButtons[nextIndex];
          if (!nextButton) return;
          nextButton.focus();
          selectTab(nextButton.getAttribute("data-tab"));
        }

        function handleEnterOrSpace(event, callback) {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          callback();
        }

        function loadTheme() {
          try {
            const storedTheme = window.localStorage.getItem("memo-grafter-studio-theme");
            if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
          } catch {
            return "light";
          }

          return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }

        function applyTheme(theme) {
          const normalizedTheme = theme === "dark" ? "dark" : "light";
          document.documentElement.dataset.theme = normalizedTheme;
          elements.themeToggle.textContent = normalizedTheme === "dark" ? "Light mode" : "Dark mode";
          elements.themeToggle.setAttribute("aria-pressed", String(normalizedTheme === "dark"));
        }

        function refreshActiveTab() {
          if (!state.selectedSessionId) return;
          state.actionStatus = null;

          if (state.activeTab === "tables") {
            void loadTables(state.selectedSessionId, { force: true });
            return;
          }

          if (state.activeTab === "preview") {
            if (state.preview.query.trim()) {
              void runPreview();
            } else {
              state.tabs.preview.loadedAt = new Date().toISOString();
              renderWorkspace();
            }
            return;
          }

          void loadGraph(state.selectedSessionId, { preserveSelection: true });
        }

        async function fetchJson(url, options) {
          const requestOptions = options || {};
          const response = await fetch(url, {
            ...requestOptions,
            headers: { accept: "application/json", ...(requestOptions.headers || {}) }
          });
          const body = await response.json();
          if (!response.ok) {
            throw new Error(body.error || body.message || "Request failed");
          }
          return body;
        }

        function startSessionTitleEdit() {
          const session = selectedSession();
          if (!session || state.sessionTitleSaving) return;
          state.editingSessionTitle = true;
          state.sessionTitleDraft = session.label || sessionDisplayLabel(session);
          renderHeader();
          const input = elements.titleEditor.querySelector("[data-session-title-input]");
          if (input) {
            input.focus();
            input.select();
          }
        }

        function cancelSessionTitleEdit() {
          state.editingSessionTitle = false;
          state.sessionTitleDraft = "";
          renderHeader();
        }

        async function saveSessionTitleEdit() {
          const session = selectedSession();
          if (!session || state.sessionTitleSaving) return;

          const nextLabel = state.sessionTitleDraft.trim();
          state.sessionTitleSaving = true;
          renderHeader();

          try {
            await fetchJson("/api/sessions/" + encodeURIComponent(session.id), {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ label: nextLabel })
            });
            state.editingSessionTitle = false;
            state.sessionTitleDraft = "";
            await loadSessions();
          } catch (error) {
            state.error = error.message || String(error);
            renderSessions();
            renderHeader();
          } finally {
            state.sessionTitleSaving = false;
            renderHeader();
          }
        }

        function handleSessionTitleKeydown(event) {
          if (event.key === "Enter") {
            event.preventDefault();
            void saveSessionTitleEdit();
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            cancelSessionTitleEdit();
          }
        }

        function filteredSessions() {
          const query = state.sessionSearchQuery;
          if (!query) return state.sessions;

          return state.sessions.filter((session) => sessionSearchText(session).includes(query));
        }

        function sessionSearchText(session) {
          return [
            session.id,
            shortSessionId(session.id),
            session.label,
            session.displayLabel,
            sessionDisplayLabel(session)
          ].filter(Boolean).join(" ").toLowerCase();
        }

        function selectedSession() {
          return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
        }

        function sessionDisplayLabel(session) {
          return (session && (session.displayLabel || session.label)) || shortSessionId(session && session.id);
        }

        function shortSessionId(sessionId) {
          const value = String(sessionId || "");
          return value.length <= 12 ? value : value.slice(0, 8) + "...";
        }

        function renderSessions() {
          const visibleSessions = filteredSessions();
          if (state.loadingSessions && state.sessions.length === 0) {
            elements.sessionList.innerHTML = '<li class="subtle" style="padding: 12px;">Loading sessions...</li>';
            return;
          }

          if (state.error && state.sessions.length === 0) {
            elements.sessionList.innerHTML = '<li class="subtle" style="padding: 12px;">' + escapeHtml(state.error) + '</li>';
            return;
          }

          if (state.sessions.length === 0) {
            elements.sessionList.innerHTML = '<li class="subtle" style="padding: 12px;">No sessions found.</li>';
            return;
          }

          if (visibleSessions.length === 0) {
            elements.sessionList.innerHTML = '<li class="subtle" style="padding: 12px;">No sessions match this search.</li>';
            return;
          }

          elements.sessionList.innerHTML = visibleSessions.map((session) => {
            const active = session.id === state.selectedSessionId ? "true" : "false";
            const displayLabel = sessionDisplayLabel(session);
            const shortId = session.id;
            return '<li><button class="session-button" type="button" aria-current="' + active + '" data-session-id="' + escapeAttribute(session.id) + '">' +
              '<span class="session-label">' + escapeHtml(displayLabel) + '</span>' +
              '<span class="session-secondary">' + escapeHtml(shortId) + '</span>' +
              '<span class="session-meta">' +
                '<span>' + numberText(session.topicCount) + ' topics</span>' +
                '<span>' + numberText(session.memoryCount) + ' memories</span>' +
                '<span>' + numberText(session.messageCount) + ' messages</span>' +
                '<span>' + formatDate(session.lastUpdatedAt) + '</span>' +
              '</span>' +
              '<span class="tag-row">' + sessionBadges(session).map((label) => '<span class="badge">' + escapeHtml(label) + '</span>').join("") + '</span>' +
            '</button></li>';
          }).join("");

          elements.sessionList.querySelectorAll("[data-session-id]").forEach((button) => {
            button.addEventListener("click", () => loadGraph(button.getAttribute("data-session-id")));
          });
        }

        function renderHeader() {
          const activeTabState = state.tabs[state.activeTab] || state.tabs.graph;
          elements.refreshGraph.disabled = !state.selectedSessionId || activeTabState.loading;
          elements.refreshGraph.textContent = "Refresh " + tabLabel(state.activeTab);
          if (!state.selectedSessionId) {
            state.editingSessionTitle = false;
            elements.titleEditor.innerHTML = '<button class="title-button" id="page-title" type="button" disabled>Select a session</button>';
            elements.pageTitle = document.getElementById("page-title");
            elements.pageSubtitle.textContent = "Workspace data loads only after you choose a session.";
            return;
          }

          const session = selectedSession();
          const title = session ? sessionDisplayLabel(session) : "Session " + state.selectedSessionId;
          renderTitleEditor(title);
          const health = state.ingestionHealth && state.ingestionHealth.available
            ? " · Ingestion: " + state.ingestionHealth.status + " · Pending: " + numberText(state.ingestionHealth.pendingMessages)
            : "";
          elements.pageSubtitle.textContent = activeTabState.loading
            ? "Loading " + tabLabel(state.activeTab).toLowerCase() + " data..."
            : state.selectedSessionId + health;
        }

        function renderTitleEditor(title) {
          if (state.editingSessionTitle) {
            elements.titleEditor.innerHTML =
              '<input class="title-input" data-session-title-input value="' + escapeAttribute(state.sessionTitleDraft) + '" aria-label="Session label">' +
              '<button class="icon-button title-save" type="button" data-session-title-save title="Save session label"' + (state.sessionTitleSaving ? " disabled" : "") + '>&#10003;</button>' +
              '<span class="title-status">' + escapeHtml(state.sessionTitleSaving ? "Saving..." : "Enter to save / Esc to cancel") + '</span>';
            const input = elements.titleEditor.querySelector("[data-session-title-input]");
            const save = elements.titleEditor.querySelector("[data-session-title-save]");
            if (input) {
              input.addEventListener("input", () => {
                state.sessionTitleDraft = input.value;
              });
              input.addEventListener("keydown", handleSessionTitleKeydown);
            }
            if (save) {
              save.addEventListener("click", () => saveSessionTitleEdit());
            }
            return;
          }

          elements.titleEditor.innerHTML =
            '<button class="title-button" id="page-title" type="button" title="Edit session label">' + escapeHtml(title) + '</button>';
          elements.pageTitle = document.getElementById("page-title");
          elements.pageTitle.addEventListener("click", () => startSessionTitleEdit());
        }

        function tabLabel(tab) {
          if (tab === "tables") return "Tables";
          if (tab === "preview") return "Invoke Preview";
          return "Graph";
        }

        function renderWorkspace() {
          elements.tabButtons.forEach((button) => {
            const active = button.getAttribute("data-tab") === state.activeTab;
            button.setAttribute("aria-selected", active ? "true" : "false");
            button.setAttribute("tabindex", active ? "0" : "-1");
          });
          const activeTabButton = elements.tabButtons.find((button) => button.getAttribute("data-tab") === state.activeTab);
          if (activeTabButton) {
            elements.graphStage.parentElement.setAttribute("aria-labelledby", activeTabButton.id);
          }
          elements.graphFilters.classList.toggle("hidden", state.activeTab !== "graph");
          elements.graphSearch.classList.toggle("hidden", state.activeTab !== "graph");
          const singlePane = state.activeTab === "tables" || state.activeTab === "preview";
          elements.contentGrid.classList.toggle("single-pane", singlePane);
          elements.detailsSection.classList.toggle("hidden", singlePane);
          elements.contentGrid.style.gridTemplateColumns = singlePane ? "minmax(0, 1fr)" : "";
          elements.detailsSection.hidden = singlePane;
          elements.detailsSection.style.display = singlePane ? "none" : "";
          elements.workspaceTitle.textContent = tabLabel(state.activeTab);
          renderHeader();

          if (!state.selectedSessionId) {
            elements.graphStage.innerHTML = '<div class="empty-state" role="status">Choose a session to load its workspace.</div>';
            elements.graphSummary.textContent = "";
            renderDetailsPanel();
            return;
          }

          if (state.activeTab === "tables") {
            renderTables();
            return;
          }

          if (state.activeTab === "preview") {
            renderPreviewPlaceholder();
            return;
          }

          renderGraph();
        }

        function renderTables() {
          const tab = state.tabs.tables;
          elements.graphSummary.textContent = "";

          if (tab.loading && !state.tables) {
            elements.graphStage.innerHTML = '<div class="loading-state" role="status" aria-live="polite">Loading tables...</div>';
            renderDetailsPanel();
            return;
          }

          if (tab.error && !state.tables) {
            elements.graphStage.innerHTML = '<div class="error-state" role="alert">' + escapeHtml(tab.error) + '</div>';
            renderDetailsPanel();
            return;
          }

          const browserTables = getBrowserTables();
          ensureSelectedBrowserTable(browserTables);
          const table = browserTables.find((candidate) => candidate.name === state.tablesBrowser.selectedTable) || browserTables[0];
          const totalRows = table ? table.rows.length : 0;
          const pageSize = state.tablesBrowser.pageSize;
          const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
          state.tablesBrowser.page = Math.min(Math.max(1, state.tablesBrowser.page), totalPages);
          const start = (state.tablesBrowser.page - 1) * pageSize;
          const visibleRows = table ? table.rows.slice(start, start + pageSize) : [];
          const columns = getTableColumns(table);

          elements.graphSummary.innerHTML = browserTables.map((candidate) =>
            '<span>' + escapeHtml(candidate.name) + ': ' + numberText(candidate.rows.length) + '</span>'
          ).join("");
          elements.graphStage.innerHTML = renderTableBrowser(browserTables, table, columns, visibleRows, start, totalRows, totalPages);

          const tableSelect = elements.graphStage.querySelector("[data-table-browser-select]");
          if (tableSelect) {
            tableSelect.addEventListener("change", () => {
              state.tablesBrowser.selectedTable = tableSelect.value;
              state.tablesBrowser.page = 1;
              state.tablesBrowser.expandedCell = null;
              renderWorkspace();
            });
          }

          const pageSizeSelect = elements.graphStage.querySelector("[data-table-page-size]");
          if (pageSizeSelect) {
            pageSizeSelect.addEventListener("change", () => {
              state.tablesBrowser.pageSize = Number.parseInt(pageSizeSelect.value, 10) || 25;
              state.tablesBrowser.page = 1;
              state.tablesBrowser.expandedCell = null;
              renderWorkspace();
            });
          }

          elements.graphStage.querySelectorAll("[data-page-action]").forEach((button) => {
            button.addEventListener("click", () => {
              const action = button.getAttribute("data-page-action");
              state.tablesBrowser.page += action === "next" ? 1 : -1;
              state.tablesBrowser.expandedCell = null;
              renderWorkspace();
            });
          });

          elements.graphStage.querySelectorAll("[data-db-cell-column]").forEach((cell) => {
            const toggleCell = () => {
              const rowIndex = Number.parseInt(cell.getAttribute("data-db-cell-row") || "0", 10);
              const columnName = cell.getAttribute("data-db-cell-column") || "";
              const current = state.tablesBrowser.expandedCell;
              state.tablesBrowser.expandedCell = current
                && current.tableName === table.name
                && current.rowIndex === rowIndex
                && current.columnName === columnName
                  ? null
                  : { tableName: table.name, rowIndex, columnName };
              renderWorkspace();
            };
            cell.addEventListener("click", toggleCell);
            cell.addEventListener("keydown", (event) => handleEnterOrSpace(event, toggleCell));
          });
        }

        function getBrowserTables() {
          if (state.tables && Array.isArray(state.tables.tables) && state.tables.tables.length > 0) {
            return state.tables.tables.map((table) => ({
              name: table.name,
              rows: (table.rows || []).map(normalizeDbRow)
            }));
          }

          const source = state.tables || {};
          return [
            { name: "mg_message_buffer", rows: (source.messages || []).map((message, index) => normalizeDbRow({ message_index: index, role: message.role, content: message.content })) },
            { name: "mg_segments", rows: (source.segments || []).map((segment) => normalizeDbRow(toSnakeRow(segment))) },
            { name: "mg_topic_nodes", rows: (source.topics || []).map((topic) => normalizeDbRow(toSnakeRow(topic))) },
            { name: "mg_topic_clusters", rows: (source.clusters || []).map((cluster) => normalizeDbRow(toSnakeRow(cluster))) },
            { name: "mg_memory_nodes", rows: (source.memories || []).map((memory) => normalizeDbRow(toSnakeRow(memory))) }
          ];
        }

        function ensureSelectedBrowserTable(tables) {
          if (!tables.some((table) => table.name === state.tablesBrowser.selectedTable)) {
            state.tablesBrowser.selectedTable = tables[0] ? tables[0].name : "mg_topic_nodes";
            state.tablesBrowser.page = 1;
            state.tablesBrowser.expandedCell = null;
          }
        }

        function renderTableBrowser(tables, table, columns, rows, start, totalRows, totalPages) {
          const selectedName = table ? table.name : "";
          return '<div class="table-browser">' +
            '<div class="table-browser-toolbar">' +
              '<div class="table-browser-controls">' +
                '<div class="field"><label for="table-browser-select">Table</label><select class="table-select" id="table-browser-select" data-table-browser-select>' +
                  tables.map((candidate) => '<option value="' + escapeAttribute(candidate.name) + '"' + (candidate.name === selectedName ? " selected" : "") + '>' + escapeHtml(candidate.name) + '</option>').join("") +
                '</select></div>' +
                '<div class="field"><label for="table-page-size">Page size</label><select id="table-page-size" data-table-page-size>' +
                  [10, 25, 50, 100].map((size) => '<option value="' + size + '"' + (size === state.tablesBrowser.pageSize ? " selected" : "") + '>' + size + '</option>').join("") +
                '</select></div>' +
              '</div>' +
              '<div class="pagination-controls">' +
                '<span class="subtle">' + escapeHtml(numberText(totalRows)) + ' rows · page ' + numberText(state.tablesBrowser.page) + ' of ' + numberText(totalPages) + '</span>' +
                '<button class="icon-button" type="button" data-page-action="previous"' + (state.tablesBrowser.page <= 1 ? " disabled" : "") + '>Previous</button>' +
                '<button class="icon-button" type="button" data-page-action="next"' + (state.tablesBrowser.page >= totalPages ? " disabled" : "") + '>Next</button>' +
              '</div>' +
            '</div>' +
            renderDbTable(selectedName, columns, rows, start) +
          '</div>';
        }

        function renderDbTable(tableName, columns, rows, start) {
          if (!tableName) return '<div class="table-empty">No tables are available for this session.</div>';
          if (columns.length === 0) return '<div class="table-empty">' + escapeHtml(tableName) + ' has no rows to display.</div>';

          return '<div class="data-table-section">' +
            '<div class="data-table-heading"><p class="panel-title">' + escapeHtml(tableName) + '</p><span class="badge">read-only</span></div>' +
            '<div class="data-table-wrap"><table class="db-table"><thead><tr>' +
              columns.map((column) => '<th scope="col">' + escapeHtml(column) + '</th>').join("") +
            '</tr></thead><tbody>' +
              rows.map((row, index) => {
                const absoluteRow = start + index + 1;
                return '<tr>' + columns.map((column) => renderDbCell(tableName, row, absoluteRow, column)).join("") + '</tr>';
              }).join("") +
            '</tbody></table></div>' +
          '</div>';
        }

        function renderDbCell(tableName, row, rowIndex, columnName) {
          const expanded = state.tablesBrowser.expandedCell
            && state.tablesBrowser.expandedCell.tableName === tableName
            && state.tablesBrowser.expandedCell.rowIndex === rowIndex
            && state.tablesBrowser.expandedCell.columnName === columnName;
          const value = expanded ? formatFullCellValue(row[columnName]) : formatCellPreview(row[columnName]);
          return '<td class="db-cell' + (expanded ? " selected" : "") + '" tabindex="0" role="button" aria-expanded="' + (expanded ? "true" : "false") + '" aria-label="' + escapeAttribute((expanded ? "Collapse " : "Expand ") + columnName + " cell in row " + rowIndex) + '" title="Click to expand or collapse" data-db-cell-row="' + rowIndex + '" data-db-cell-column="' + escapeAttribute(columnName) + '">' +
            (expanded
              ? '<span class="db-cell-expanded">' + escapeHtml(value) + '</span>'
              : clipped(value, 260)) +
          '</td>';
        }

        function getTableColumns(table) {
          if (!table) return [];
          const preferred = tableColumnOrder(table.name);
          const observed = [];
          for (const row of table.rows) {
            Object.keys(row).forEach((key) => {
              if (!observed.includes(key)) observed.push(key);
            });
          }
          return preferred.filter((column) => observed.includes(column))
            .concat(observed.filter((column) => !preferred.includes(column)));
        }

        function tableColumnOrder(name) {
          const columns = {
            mg_message_buffer: ["session_id", "message_index", "role", "content"],
            mg_segments: ["id", "session_id", "start_index", "end_index", "topic_order", "drift_score", "created_at"],
            mg_topic_nodes: ["id", "session_id", "segment_id", "label", "summary", "embedding", "tags", "source", "message_range", "topic_order", "drift_score", "agent_color", "fleet_id", "agent_id", "suppressed", "suppressed_at", "pinned", "pinned_at", "created_at"],
            mg_topic_edges: ["src_id", "dst_id", "weight", "type"],
            mg_memory_nodes: ["id", "segment_id", "topic_node_id", "agent_id", "session_id", "memory_type", "source_type", "subject", "predicate", "value", "quality_explicitness", "quality_source_reliability", "quality_stability", "quality_salience", "embedding", "tags", "source", "source_url", "source_title", "superseded_by", "decayed", "forgotten", "forgotten_at", "has_conflict", "agent_color", "fleet_id", "created_at"],
            mg_memory_edges: ["id", "source_id", "target_id", "edge_type", "weight", "created_at"],
            mg_fleets: ["id", "name", "created_at"],
            mg_fleet_agents: ["id", "fleet_id", "session_id", "agent_color", "created_at"],
            mg_sessions: ["session_id", "label", "description", "tags", "created_at", "updated_at"],
            mg_session_ingest_state: ["session_id", "last_ingested_message_index", "updated_at"],
            mg_graft_registry: ["id", "session_id", "node_id", "source_session_id", "source_node_id", "grafted_at"]
          };
          return columns[name] || [];
        }

        function normalizeDbRow(row) {
          const normalized = {};
          Object.entries(row || {}).forEach(([key, value]) => {
            normalized[toSnakeCase(key)] = value;
          });
          return normalized;
        }

        function toSnakeRow(row) {
          return normalizeDbRow(row);
        }

        function toSnakeCase(value) {
          return String(value).replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
        }

        function formatCellPreview(value) {
          if (value === null) return "null";
          if (value === undefined) return "undefined";
          if (Array.isArray(value)) return JSON.stringify(value);
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        }

        function formatFullCellValue(value) {
          if (value === null) return "null";
          if (value === undefined) return "undefined";
          if (typeof value === "object") return JSON.stringify(value, null, 2);
          return String(value);
        }

        function normalizeTables(raw) {
          const source = raw || {};
          return {
            clusters: source.clusters || [],
            topics: (source.topics || []).map((topic) => ({
              id: topic.id,
              kind: "topic",
              raw: topic,
              title: topic.label || topic.id,
              subtitle: topic.summary || "",
              tags: topic.tags || [],
              lifecycle: topic.suppressed ? "suppressed" : "active"
            })),
            memories: (source.memories || []).map((memory) => ({
              id: memory.id,
              kind: "memory",
              raw: memory,
              title: memory.subject ? memory.subject + " " + memory.predicate : memory.id,
              subtitle: memory.value || "",
              tags: memory.tags || [],
              lifecycle: memoryLifecycle(memory)
            })),
            segments: (source.segments || []).map((segment) => ({
              id: segment.id,
              kind: "segment",
              raw: segment
            })),
            messages: (source.messages || []).map((message, index) => ({
              id: "message:" + index,
              kind: "message",
              index,
              raw: message
            }))
          };
        }

        function ensureSelectedEntityExists(tables) {
          if (!state.selectedEntity || state.selectedEntity.source !== "tables") return;
          const bucket = state.selectedEntity.kind === "topic" ? tables.topics
            : state.selectedEntity.kind === "memory" ? tables.memories
              : state.selectedEntity.kind === "segment" ? tables.segments
                : state.selectedEntity.kind === "message" ? tables.messages
                  : [];
          if (!bucket.some((item) => item.id === state.selectedEntity.id)) {
            state.selectedEntity = null;
          }
        }

        function renderTopicTable(rows) {
          return renderDataTable("Topics", rows.length, ["Label", "Summary", "Tags", "Lifecycle", "Message range", "Created", "ID"], rows.map((row) => {
            const raw = row.raw;
            return tableRow(row, [
              clipped(raw.label || raw.id, 180),
              clipped(raw.summary || "None", 320),
              tagsMarkup(raw.tags || []),
              badgeMarkup(row.lifecycle),
              escapeHtml(formatMessageRange(raw.messageRange)),
              escapeHtml(formatDate(raw.createdAt)),
              clipped(raw.id, 180)
            ]);
          }));
        }

        function renderMemoryTable(rows) {
          return renderDataTable("Memories", rows.length, ["Subject", "Predicate", "Value", "Type", "Quality", "Lifecycle", "Tags", "Created", "ID"], rows.map((row) => {
            const raw = row.raw;
            return tableRow(row, [
              clipped(raw.subject || "None", 160),
              clipped(raw.predicate || "None", 140),
              clipped(raw.value || "None", 320),
              escapeHtml(raw.memoryType || "Unknown"),
              escapeHtml(raw.quality == null ? "Unknown" : JSON.stringify(raw.quality)),
              badgeMarkup(row.lifecycle),
              tagsMarkup(raw.tags || []),
              escapeHtml(formatDate(raw.createdAt)),
              clipped(raw.id, 180)
            ]);
          }));
        }

        function renderSegmentTable(rows) {
          return renderDataTable("Segments", rows.length, ["Order", "Message range", "Drift score", "Created", "ID"], rows.map((row) => {
            const raw = row.raw;
            return tableRow(row, [
              escapeHtml(raw.topicOrder == null ? "Unknown" : String(raw.topicOrder)),
              escapeHtml(formatSegmentRange(raw)),
              escapeHtml(raw.driftScore == null ? "Unknown" : String(raw.driftScore)),
              escapeHtml(formatDate(raw.createdAt)),
              clipped(raw.id, 220)
            ]);
          }));
        }

        function renderMessageTable(rows) {
          return renderDataTable("Message buffer", rows.length, ["Index", "Role", "Content", "Approx length"], rows.map((row) => {
            const raw = row.raw;
            const content = raw.content || "";
            return tableRow(row, [
              escapeHtml(String(row.index)),
              badgeMarkup(raw.role || "unknown"),
              clipped(content, 520),
              escapeHtml(numberText(content.length) + " chars")
            ]);
          }));
        }

        function renderDataTable(title, count, columns, rowMarkup) {
          return '<section class="data-table-section">' +
            '<div class="data-table-heading"><p class="panel-title">' + escapeHtml(title) + '</p><span class="badge">' + numberText(count) + '</span></div>' +
            (count === 0
              ? '<div class="table-empty">No ' + escapeHtml(title.toLowerCase()) + ' found for this session.</div>'
              : '<div class="data-table-wrap"><table class="data-table"><thead><tr>' +
                columns.map((column) => '<th scope="col">' + escapeHtml(column) + '</th>').join("") +
                '</tr></thead><tbody>' + rowMarkup.join("") + '</tbody></table></div>') +
          '</section>';
        }

        function tableRow(row, cells) {
          const selected = state.selectedEntity && state.selectedEntity.kind === row.kind && state.selectedEntity.id === row.id ? " selected" : "";
          return '<tr class="' + selected + '" tabindex="0" data-table-entity-kind="' + escapeAttribute(row.kind) + '" data-table-entity-id="' + escapeAttribute(row.id) + '">' +
            cells.map((cell) => '<td>' + cell + '</td>').join("") +
          '</tr>';
        }

        function clipped(value, length) {
          return '<span class="table-cell-clip" title="' + escapeAttribute(value || "") + '">' + escapeHtml(truncate(value || "", length)) + '</span>';
        }

        function badgeMarkup(label) {
          return '<span class="badge">' + escapeHtml(label || "unknown") + '</span>';
        }

        function renderTablesPlaceholder() {
          const tab = state.tabs.tables;
          elements.graphSummary.textContent = "";

          if (tab.loading && !state.tables) {
            elements.graphStage.innerHTML = '<div class="loading-state" role="status" aria-live="polite">Loading tables...</div>';
            renderDetailsPanel();
            return;
          }

          if (tab.error && !state.tables) {
            elements.graphStage.innerHTML = '<div class="error-state" role="alert">' + escapeHtml(tab.error) + '</div>';
            renderDetailsPanel();
            return;
          }

          const counts = state.tables
            ? [
              numberText((state.tables.topics || []).length) + " topics",
              numberText((state.tables.memories || []).length) + " memories",
              numberText((state.tables.segments || []).length) + " segments",
              numberText((state.tables.messages || []).length) + " messages"
            ]
            : ["not loaded"];
          elements.graphSummary.innerHTML = counts.map((label) => '<span>' + escapeHtml(label) + '</span>').join("");
          elements.graphStage.innerHTML =
            '<div class="workspace-placeholder" role="status"><div class="placeholder-card">' +
              '<h2 class="panel-title">Tables</h2>' +
              '<p class="subtle">Tables data is available through the read-only tables workspace.</p>' +
              '<p class="subtle">' + escapeHtml(counts.join(" · ")) + '</p>' +
            '</div></div>';
          renderDetailsPanel();
        }

        function renderPreviewPlaceholder() {
          const status = previewStatus();
          elements.graphSummary.innerHTML =
            '<span>' + (status.available ? "available" : "unavailable") + '</span>' +
            (state.preview.result ? '<span>' + escapeHtml(tokenUsageText(state.preview.result)) + '</span>' : "");
          elements.graphStage.innerHTML = renderPreviewWorkspace(status);
          bindPreviewEvents(status);
          renderDetailsPanel();
        }

        function previewStatus() {
          return initialState.previewStatus || { available: false, reason: "Invoke Preview is not configured." };
        }

        function renderPreviewWorkspace(status) {
          return '<div class="preview-workspace">' +
            '<section class="panel">' +
              '<div class="panel-header"><p class="panel-title">Invoke Preview</p><span class="badge">Database-backed preview</span><span class="badge">' + escapeHtml(status.available ? "available" : "unavailable") + '</span></div>' +
              '<div class="details">' +
                '<div class="preview-form">' +
                  '<div class="field"><label for="preview-query">User query</label><textarea id="preview-query" ' + (!status.available ? "disabled" : "") + ' placeholder="Enter the message that would be passed to invoke()...">' + escapeHtml(state.preview.query) + '</textarea></div>' +
                  '<div class="table-browser-controls">' +
                    '<div class="field"><label for="preview-profile">Invocation profile</label><select id="preview-profile" ' + (!status.available ? "disabled" : "") + '>' +
                      '<option value="memo-grafter-agent"' + (state.preview.profile === "memo-grafter-agent" ? " selected" : "") + '>MemoGrafterAgent</option>' +
                      '<option value="fleet-worker"' + (state.preview.profile === "fleet-worker" ? " selected" : "") + '>Fleet Worker</option>' +
                    '</select></div>' +
                    (state.preview.profile === "fleet-worker" ? '<div class="field"><label for="fleet-memory-mode">Memory mode</label><select id="fleet-memory-mode"><option value="local"' + (state.preview.fleetMemoryMode === "local" ? " selected" : "") + '>local</option><option value="fleet"' + (state.preview.fleetMemoryMode === "fleet" ? " selected" : "") + '>fleet</option><option value="both"' + (state.preview.fleetMemoryMode === "both" ? " selected" : "") + '>both</option></select></div>' : '') +
                    '<div class="preview-actions">' +
                      '<button class="primary-button" type="button" id="run-preview"' + (!status.available || state.preview.loading || !state.preview.query.trim() ? " disabled" : "") + '>Run preview</button>' +
                      '<button class="icon-button" type="button" id="clear-preview"' + (state.preview.loading ? " disabled" : "") + '>Clear</button>' +
                    '</div>' +
                  '</div>' +
                  '<p class="subtle">' + escapeHtml(status.available ? "Framework-level { system, messages } request. No LLM call or memory write is performed. Persisted history is used because live agent history is process-local." : (status.reason || "Invoke Preview is unavailable.")) + '</p>' +
                  (state.preview.error ? '<div class="action-status error" role="alert">' + escapeHtml(state.preview.error) + '</div>' : "") +
                '</div>' +
              '</div>' +
            '</section>' +
            renderPreviewResult(status) +
          '</div>';
        }

        function renderPreviewResult(status) {
          if (!status.available) {
            return '<div class="workspace-placeholder" role="status"><div class="placeholder-card"><h2 class="panel-title">Invoke Preview unavailable</h2><p class="subtle">' + escapeHtml(status.reason || "Configure an embedder to enable invoke preview.") + '</p></div></div>';
          }

          if (state.preview.loading) {
            return '<div class="loading-state" role="status" aria-live="polite">Planning invocation...</div>';
          }

          const result = state.preview.result;
          if (!result) {
            return '<div class="workspace-placeholder" role="status"><div class="placeholder-card"><h2 class="panel-title">No preview yet</h2><p class="subtle">Enter a query and generate the request MemoGrafter would prepare for the selected runtime.</p></div></div>';
          }

          const statusText = result.retrieval && result.retrieval.status ? result.retrieval.status : "unknown";
          return '<section class="preview-result">' +
            '<div class="preview-result-header">' +
              '<div class="preview-summary">' +
                '<span class="badge">' + escapeHtml(result.profile) + '</span>' +
                '<span class="badge">' + escapeHtml(statusText) + '</span>' +
                '<span class="' + tokenUsageClass(result) + '">' + escapeHtml(tokenUsageText(result)) + '</span>' +
                '<span class="badge">' + escapeHtml(previewCountsText(result)) + '</span>' +
              '</div>' +
              '<div class="preview-actions">' +
                '<button class="icon-button" type="button" id="copy-preview">' + (state.preview.subview === "plain" ? "Copy plain text" : state.preview.subview === "messages" ? "Copy request JSON" : "Copy view") + '</button>' +
                (state.preview.copied ? '<span class="subtle">Copied</span>' : "") +
              '</div>' +
            '</div>' +
            '<p class="subtle">Framework-level MemoGrafter request; provider adapters may transform it. This is not a byte-for-byte provider payload.</p>' +
            '<div class="preview-actions">' + [
              ["context", "Context Selection"], ["messages", "Structured Messages"], ["plain", "Final Prompt — Plain Text"], ["memory", "Raw Memory Context"], ["retrieval", "Why These Memories?"]
            ].map(function(item) { return '<button class="icon-button preview-subview" data-subview="' + item[0] + '" type="button" aria-pressed="' + (state.preview.subview === item[0]) + '">' + item[1] + '</button>'; }).join("") + '</div>' +
            '<pre class="prompt-preview-output" id="prompt-preview-output">' + escapeHtml(previewSubviewText(result)) + '</pre>' +
            renderCompletionPanel(result) +
          '</section>';
        }

        function previewSubviewText(result) {
          if (state.preview.subview === "messages") return JSON.stringify(result.request || { system: "", messages: [] }, null, 2);
          if (state.preview.subview === "plain") return result.plainText || "No readable request rendering was generated.";
          if (state.preview.subview === "memory") return (result.memoryContext && result.memoryContext.content) || (result.retrieval && result.retrieval.status === "failed" ? "Retrieval failed: " + result.retrieval.error.message : "No matching memory context was added.");
          if (state.preview.subview === "context") return JSON.stringify({ baseSystemPrompt: result.baseSystemPrompt, conversationWindow: result.conversationWindow, userQuery: result.query, tokens: result.tokens }, null, 2);
          return JSON.stringify(result.retrieval || {}, null, 2);
        }

        function renderCompletionPanel(result) {
          const completion = (initialState.previewStatus && initialState.previewStatus.completion) || { available: false, reason: "Configure an LLM adapter and provider API key in mg.config.ts." };
          const provider = [completion.provider, completion.model].filter(Boolean).join(" · ");
          const response = state.preview.completionResult;
          return '<section class="panel"><div class="panel-header"><p class="panel-title">Test with configured LLM</p><span class="badge">' + escapeHtml(completion.available ? (provider || "available") : "unavailable") + '</span></div><div class="details">' +
            '<p class="subtle">This sends the displayed request to your configured LLM using the provider API key available to MemoGrafter Studio. Provider usage charges may apply. Preview generation alone never calls the LLM.</p>' +
            (!completion.available ? '<div class="action-status warning">' + escapeHtml(completion.reason || "LLM execution is unavailable.") + '</div>' : '') +
            '<div class="preview-actions"><button class="primary-button" type="button" id="run-completion"' + (!completion.available || state.preview.completionLoading ? " disabled" : "") + '>' + (state.preview.completionLoading ? "Running…" : "Run with LLM") + '</button></div>' +
            (response ? '<div class="detail-section"><h2 class="detail-section-title">LLM Response</h2><p class="subtle">Not persisted to conversation history or memory · ' + numberText(response.durationMs) + ' ms</p><pre class="prompt-preview-output">' + escapeHtml(response.response) + '</pre><button class="icon-button" id="copy-completion" type="button">Copy response</button></div>' : '') +
          '</div></section>';
        }

        function bindPreviewEvents(status) {
          const queryInput = document.getElementById("preview-query");
          const profileSelect = document.getElementById("preview-profile");
          const fleetModeSelect = document.getElementById("fleet-memory-mode");
          const runButton = document.getElementById("run-preview");
          const clearButton = document.getElementById("clear-preview");
          const copyButton = document.getElementById("copy-preview");
          const completionButton = document.getElementById("run-completion");
          const copyCompletionButton = document.getElementById("copy-completion");

          if (queryInput) {
            queryInput.addEventListener("input", () => {
              state.preview.query = queryInput.value;
              state.preview.error = null;
              state.preview.copied = false;
              if (runButton) {
                runButton.disabled = !status.available || state.preview.loading || !state.preview.query.trim();
              }
            });
          }

          if (profileSelect) {
            profileSelect.addEventListener("change", () => {
              state.preview.profile = profileSelect.value;
              state.preview.error = null;
              state.preview.copied = false;
              renderWorkspace();
            });
          }
          if (fleetModeSelect) fleetModeSelect.addEventListener("change", () => { state.preview.fleetMemoryMode = fleetModeSelect.value; state.preview.result = null; renderWorkspace(); });
          document.querySelectorAll(".preview-subview").forEach(function(button) { button.addEventListener("click", function() { state.preview.subview = button.dataset.subview; renderWorkspace(); }); });

          if (runButton) {
            runButton.addEventListener("click", () => {
              if (status.available) void runPreview();
            });
          }

          if (clearButton) {
            clearButton.addEventListener("click", () => {
              state.preview.result = null;
              state.preview.completionResult = null;
              state.preview.error = null;
              state.preview.copied = false;
              renderWorkspace();
            });
          }

          if (copyButton) {
            copyButton.addEventListener("click", () => void copyPreviewPrompt());
          }
          if (completionButton) completionButton.addEventListener("click", () => void runPreviewCompletion());
          if (copyCompletionButton) copyCompletionButton.addEventListener("click", () => void navigator.clipboard.writeText(state.preview.completionResult.response));
        }

        async function runPreview() {
          const query = state.preview.query.trim();
          if (!state.selectedSessionId || !query || state.preview.loading) return;

          const requestId = state.preview.requestId + 1;
          state.preview.requestId = requestId;
          state.preview.loading = true;
          state.preview.error = null;
          state.preview.copied = false;
          state.tabs.preview.loading = true;
          renderWorkspace();

          try {
            const body = {
              profile: state.preview.profile,
              fleetMemoryMode: state.preview.fleetMemoryMode,
              query: query
            };
            const result = await fetchJson("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/invocation-preview", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            });
            if (state.preview.requestId !== requestId) return;
            state.preview.result = result;
            state.preview.completionResult = null;
            state.tabs.preview.loadedAt = new Date().toISOString();
          } catch (error) {
            if (state.preview.requestId !== requestId) return;
            state.preview.error = error.message || String(error);
          } finally {
            if (state.preview.requestId === requestId) {
              state.preview.loading = false;
              state.tabs.preview.loading = false;
              renderWorkspace();
            }
          }
        }

        async function copyPreviewPrompt() {
          const result = state.preview.result;
          if (!result) return;

          try {
            await navigator.clipboard.writeText(previewSubviewText(result));
            state.preview.copied = true;
          } catch {
            state.preview.error = "Could not copy request JSON to clipboard.";
          }
          renderWorkspace();
        }

        async function runPreviewCompletion() {
          const result = state.preview.result;
          if (!result || !result.planId || state.preview.completionLoading) return;
          const confirmed = window.confirm("Run this invocation?\\n\\nThis will send the displayed system prompt and messages to the configured LLM using your API key. Provider usage charges may apply.");
          if (!confirmed) return;
          state.preview.completionLoading = true;
          state.preview.error = null;
          renderWorkspace();
          try {
            state.preview.completionResult = await fetchJson("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/invocation-preview/" + encodeURIComponent(result.planId) + "/complete", { method: "POST" });
          } catch (error) {
            state.preview.error = error.message || String(error);
          } finally {
            state.preview.completionLoading = false;
            renderWorkspace();
          }
        }

        function tokenUsageText(result) {
          const tokenCount = result && result.tokens ? result.tokens.total : 0;
          const tokenBudget = result && result.tokens ? result.tokens.budget : null;
          if (!tokenBudget) return "Tokens: " + numberText(tokenCount);
          const percent = Math.round((tokenCount / tokenBudget) * 100);
          return "Tokens: " + numberText(tokenCount) + " / " + numberText(tokenBudget) + " · " + percent + "%";
        }

        function tokenUsageClass(result) {
          const overBudget = result && result.tokens && result.tokens.budget && result.tokens.total > result.tokens.budget;
          return "badge token-meter" + (overBudget ? " warning" : "");
        }

        function previewCountsText(result) {
          if (!result) return "0 items";
          const nodes = result.retrieval && Array.isArray(result.retrieval.topics) ? result.retrieval.topics.length : 0;
          const memories = result.retrieval && Array.isArray(result.retrieval.memories) ? result.retrieval.memories.length : 0;
          const domains = ((result.retrieval && result.retrieval.clusterMetadata && result.retrieval.clusterMetadata.clusters) || []).map((cluster) => cluster.label);
          return numberText(memories) + " memories · " + numberText(nodes) + " topics" + (domains.length ? " · Domains: " + domains.join(", ") : "");
        }

        function handleGraphSearchKeydown(event) {
          if (event.key === "Enter") {
            event.preventDefault();
            navigateGraphSearch(event.shiftKey ? -1 : 1);
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            clearGraphSearch();
          }
        }

        function clearGraphSearch() {
          state.graphSearch = { query: "", activeMatchIndex: 0 };
          elements.graphSearchInput.value = "";
          renderGraph();
        }

        function navigateGraphSearch(direction) {
          if (!state.graph) return;
          const matches = graphSearchMatches(state.graph);
          if (matches.length === 0) return;

          const nextIndex = (state.graphSearch.activeMatchIndex + direction + matches.length) % matches.length;
          state.graphSearch.activeMatchIndex = nextIndex;
          selectGraphSearchMatch(matches[nextIndex]);
          renderGraph();
        }

        function selectGraphSearchMatch(match) {
          if (!match) return;
          selectGraphNode(match.id, null);
          state.actionStatus = null;
        }

        function graphSearchMatches(raw) {
          const query = state.graphSearch.query.trim().toLowerCase();
          if (!query) return [];

          const matches = [];
          const topicsById = new Map((raw.nodes || []).map((topic) => [topic.id, topic]));

          (raw.nodes || []).forEach((topic) => {
            const text = graphTopicSearchText(topic);
            if (!text.includes(query)) return;
            matches.push({
              id: topic.id,
              kind: "topic",
              title: topic.label || topic.id,
              snippet: topic.summary || topic.id,
              parentTopicId: topic.id,
              matchType: "topic"
            });
          });

          (raw.memories || []).forEach((memory) => {
            const text = graphMemorySearchText(memory);
            if (!text.includes(query)) return;
            const parentTopic = topicsById.get(memory.topicNodeId);
            matches.push({
              id: memory.id,
              kind: "memory",
              title: memory.subject ? memory.subject + " " + memory.predicate : memory.id,
              snippet: memory.value || memory.id,
              parentTopicId: memory.topicNodeId,
              parentTitle: parentTopic ? parentTopic.label || parentTopic.id : memory.topicNodeId,
              matchType: "memory"
            });
          });

          return matches;
        }

        function graphTopicSearchText(topic) {
          return [
            topic.id,
            topic.label,
            topic.summary,
            topic.source,
            topic.suppressed ? "suppressed" : "active",
            Array.isArray(topic.tags) ? topic.tags.join(" ") : "",
            Array.isArray(topic.messageRange) ? topic.messageRange.join(" ") : ""
          ].filter(Boolean).join(" ").toLowerCase();
        }

        function graphMemorySearchText(memory) {
          return [
            memory.id,
            memory.subject,
            memory.predicate,
            memory.value,
            memory.memoryType,
            memory.sourceType,
            memory.source,
            memory.quality == null ? "" : JSON.stringify(memory.quality),
            memoryLifecycle(memory),
            Array.isArray(memory.tags) ? memory.tags.join(" ") : ""
          ].filter(Boolean).join(" ").toLowerCase();
        }

        function renderGraph() {
          renderHeader();

          if (state.loadingGraph && !state.graph) {
            elements.graphStage.innerHTML = '<div class="loading-state" role="status" aria-live="polite">Loading graph...</div>';
            elements.graphSummary.textContent = "";
            renderDetailsPanel();
            return;
          }

          if (state.error && state.selectedSessionId && !state.graph) {
            elements.graphStage.innerHTML = '<div class="error-state" role="alert">' + escapeHtml(state.error) + '</div>';
            elements.graphSummary.textContent = "";
            renderDetailsPanel();
            return;
          }

          if (!state.graph) {
            elements.graphStage.innerHTML = '<div class="empty-state" role="status">Choose a session to load its memory graph.</div>';
            elements.graphSummary.textContent = "";
            renderDetailsPanel();
            return;
          }

          const graph = buildDisplayGraph(state.graph);
          const searchMatches = graphSearchMatches(state.graph);
          normalizeGraphSearchIndex(searchMatches);
          const visibleNodeIds = new Set(graph.nodes.map((node) => node.id));
          const hiddenMatches = searchMatches.filter((match) => !visibleNodeIds.has(match.id)).length;
          updateGraphSearchControls(searchMatches, hiddenMatches);
          elements.graphSummary.innerHTML =
            '<span>' + numberText(graph.topicNodes.length) + ' topics</span>' +
            '<span>' + numberText(graph.memoryNodes.length) + ' memories</span>' +
            '<span>' + numberText(graph.topicEdges.length) + ' topic edges</span>' +
            '<span>' + numberText(graph.memoryEdges.length) + ' memory edges</span>';

          if (graph.nodes.length === 0) {
            elements.graphStage.innerHTML = '<div class="empty-state" role="status">No nodes match the current filters.</div>';
            renderDetailsPanel();
            return;
          }

          const selected = graph.nodes.find((node) => node.id === state.selectedGraphNodeId) || null;
          if (state.selectedGraphNodeId && !selected) {
            const entity = resolveGraphEntity(state.selectedGraphNodeId, graph);
            state.selectedEntity = entity ? { kind: entity.kind, id: entity.id, source: "graph" } : null;
          }

          elements.graphStage.innerHTML = renderGraphSearchResults(searchMatches, hiddenMatches) + renderGraphSurface(graph);
          elements.graphStage.querySelectorAll("[data-graph-node-id]").forEach((node) => {
            const selectNode = () => {
              selectGraphNode(node.getAttribute("data-graph-node-id"), graph);
              state.actionStatus = null;
              renderGraph();
            };
            node.addEventListener("pointerdown", (event) => {
              event.preventDefault();
              selectNode();
            });
            node.addEventListener("click", selectNode);
            node.addEventListener("keydown", (event) => handleEnterOrSpace(event, selectNode));
            node.addEventListener("mouseenter", () => {
              state.hoveredGraphNodeId = node.getAttribute("data-graph-node-id");
              renderGraph();
            });
            node.addEventListener("mouseleave", () => {
              state.hoveredGraphNodeId = null;
              renderGraph();
            });
            node.addEventListener("focus", () => {
              state.hoveredGraphNodeId = node.getAttribute("data-graph-node-id");
              renderGraph();
            });
            node.addEventListener("blur", () => {
              state.hoveredGraphNodeId = null;
              renderGraph();
            });
          });
          elements.graphStage.querySelectorAll("[data-graph-search-result-id]").forEach((button) => {
            button.addEventListener("click", () => {
              const id = button.getAttribute("data-graph-search-result-id");
              const index = Number.parseInt(button.getAttribute("data-graph-search-result-index") || "0", 10);
              const match = searchMatches[index] || searchMatches.find((candidate) => candidate.id === id);
              if (!match) return;
              state.graphSearch.activeMatchIndex = index;
              selectGraphSearchMatch(match);
              renderGraph();
            });
          });
          elements.graphStage.querySelectorAll("[data-graph-nav-action]").forEach((button) => {
            button.addEventListener("click", () => handleGraphNavigatorAction(button.getAttribute("data-graph-nav-action"), graph));
          });
          elements.graphStage.querySelectorAll("[data-graph-cluster-toggle]").forEach((button) => {
            button.addEventListener("click", () => toggleGraphCluster(button.getAttribute("data-graph-cluster-toggle")));
          });

          renderDetailsPanel();
        }

        function normalizeGraphSearchIndex(matches) {
          if (matches.length === 0) {
            state.graphSearch.activeMatchIndex = 0;
            return;
          }

          state.graphSearch.activeMatchIndex = Math.min(Math.max(0, state.graphSearch.activeMatchIndex), matches.length - 1);
        }

        function updateGraphSearchControls(matches, hiddenMatches) {
          const hasQuery = Boolean(state.graphSearch.query.trim());
          const hasMatches = matches.length > 0;
          elements.graphSearchClear.disabled = !hasQuery;

          if (!hasQuery) {
            elements.graphSearchCount.textContent = "";
            return;
          }

          if (!hasMatches) {
            elements.graphSearchCount.textContent = "0 matches";
            return;
          }

          const hiddenText = hiddenMatches > 0 ? ", " + numberText(hiddenMatches) + " hidden by filters" : "";
          elements.graphSearchCount.textContent = numberText(state.graphSearch.activeMatchIndex + 1) + " of " + numberText(matches.length) + hiddenText;
        }

        function renderGraphSearchResults(matches, hiddenMatches) {
          if (!state.graphSearch.query.trim() || matches.length === 0) return "";
          const hiddenHint = hiddenMatches > 0
            ? '<span class="subtle">' + numberText(hiddenMatches) + ' hidden by filters</span>'
            : "";
          return '<div class="graph-search-results">' +
            '<div class="summary-strip"><span>' + numberText(matches.length) + ' graph matches</span>' + hiddenHint + '</div>' +
            '<div class="graph-search-result-list">' + matches.slice(0, 12).map((match, index) => renderGraphSearchResult(match, index)).join("") + '</div>' +
          '</div>';
        }

        function renderGraphSearchResult(match, index) {
          const active = index === state.graphSearch.activeMatchIndex ? " active" : "";
          const parent = match.kind === "memory" && match.parentTitle ? " in " + match.parentTitle : "";
          return '<button class="graph-search-result' + active + '" type="button" data-graph-search-result-id="' + escapeAttribute(match.id) + '" data-graph-search-result-index="' + index + '">' +
            '<span class="badge">' + escapeHtml(match.kind) + '</span>' +
            '<span>' + escapeHtml(truncate(match.title + parent + ": " + match.snippet, 72)) + '</span>' +
          '</button>';
        }

        function handleGraphStageClick(event) {
          if (state.activeTab !== "graph" || !state.graph) return;
          const target = event.target;
          if (!target || typeof target.closest !== "function") return;
          if (target.closest("[data-graph-node-id]")
            || target.closest("[data-graph-search-result-id]")
            || target.closest("[data-graph-nav-action]")
            || target.closest("[data-graph-cluster-toggle]")) return;

          const isGraphWhitespace = target === elements.graphStage
            || target.classList.contains("graph-svg")
            || target.classList.contains("graph-overview")
            || target.classList.contains("graph-overview-grid");
          if (!isGraphWhitespace) return;

          resetGraphSelection();
        }

        function resetGraphSelection() {
          if (!state.selectedGraphNodeId && !state.selectedEntity && !state.hoveredGraphNodeId) return;
          state.selectedGraphNodeId = null;
          state.hoveredGraphNodeId = null;
          state.selectedEntity = null;
          state.actionStatus = null;
          state.expandedMemoriesTopicId = null;
          renderGraph();
        }

        function buildDisplayGraph(raw) {
          const searchMatches = graphSearchMatches(raw);
          const activeSearchMatch = searchMatches[state.graphSearch.activeMatchIndex] || null;
          const searchMatchIds = new Set(searchMatches.map((match) => match.id));
          const searchParentIds = new Set(searchMatches
            .filter((match) => match.kind === "memory")
            .map((match) => match.parentTopicId));
          const graftOrigins = new Map((raw.graftRegistry || []).map((entry) => [entry.nodeId, entry]));
          const topics = (raw.nodes || []).map((node) => ({
            id: node.id,
            kind: "topic",
            title: node.label || node.id,
            subtitle: node.summary || "",
            tags: node.tags || [],
            lifecycle: node.suppressed ? "suppressed" : "active",
            raw: { ...node, graftOrigin: graftOrigins.get(node.id) || null }
          }));
          const memories = (raw.memories || []).map((memory) => ({
            id: memory.id,
            kind: "memory",
            title: memory.subject ? memory.subject + " " + memory.predicate : memory.id,
            subtitle: memory.value || "",
            tags: memory.tags || [],
            lifecycle: memoryLifecycle(memory),
            raw: memory
          }));

          const filteredTopicNodes = topics.filter(matchesFilters);
          const memoryCandidates = memories.filter(matchesFilters);
          const selectedTopicId = selectedTopicIdForGraph(raw);
          const selectedMemory = (raw.memories || []).find((memory) => memory.id === state.selectedGraphNodeId);
          const mode = selectedMemory ? "memory-focus" : selectedTopicId ? "topic-focus" : "overview";
          const topicMemoryCounts = countMemoriesByTopic(raw);
          const topicEdgeCounts = countTopicEdges(raw);
          const focusedTopicIds = focusedTopicIdsForGraph(raw, selectedTopicId);
          const topicNodes = mode === "overview" || state.filters.nodeType === "memories"
            ? filteredTopicNodes
            : filteredTopicNodes.filter((topic) => focusedTopicIds.has(topic.id));
          const showAllMemories = mode === "overview" && state.filters.nodeType === "memories" && !selectedTopicId;
          const memoryNodes = state.filters.nodeType !== "topics"
            ? showAllMemories
              ? memoryCandidates
              : selectedTopicId
                ? memoryCandidates.filter((memory) => memory.raw.topicNodeId === selectedTopicId)
                : []
            : [];
          const visibleIds = new Set(topicNodes.concat(memoryNodes).map((node) => node.id));
          const topicEdges = (raw.edges || []).filter((edge) => visibleIds.has(edge.srcId) && visibleIds.has(edge.dstId));
          const memoryEdges = (raw.memoryEdges || []).filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId));
          const attachmentEdges = memoryNodes
            .filter((memory) => visibleIds.has(memory.raw.topicNodeId))
            .map((memory) => ({ srcId: memory.raw.topicNodeId, dstId: memory.id, type: "contains", weight: 1, attachment: true }));

          return {
            mode,
            topicNodes,
            memoryNodes,
            nodes: topicNodes.concat(memoryNodes),
            selectedTopicId,
            topicMemoryCounts,
            topicEdgeCounts,
            topicEdges: topicEdges.concat(attachmentEdges.filter((edge) => visibleIds.has(edge.srcId))),
            memoryEdges,
            searchMatchIds,
            searchParentIds,
            activeSearchId: activeSearchMatch ? activeSearchMatch.id : null
          };
        }

        function focusedTopicIdsForGraph(raw, selectedTopicId) {
          const ids = new Set();
          if (!selectedTopicId) return ids;
          ids.add(selectedTopicId);
          (raw.edges || []).forEach((edge) => {
            if (edge.srcId === selectedTopicId) ids.add(edge.dstId);
            if (edge.dstId === selectedTopicId) ids.add(edge.srcId);
          });
          return ids;
        }

        function countMemoriesByTopic(raw) {
          const counts = new Map();
          (raw.memories || []).forEach((memory) => {
            counts.set(memory.topicNodeId, (counts.get(memory.topicNodeId) || 0) + 1);
          });
          return counts;
        }

        function countTopicEdges(raw) {
          const counts = new Map();
          (raw.edges || []).forEach((edge) => {
            counts.set(edge.srcId, (counts.get(edge.srcId) || 0) + 1);
            counts.set(edge.dstId, (counts.get(edge.dstId) || 0) + 1);
          });
          return counts;
        }

        function selectedTopicIdForGraph(raw) {
          const selectedId = state.selectedGraphNodeId || (state.selectedEntity && state.selectedEntity.id);
          if (!selectedId) return null;

          if ((raw.nodes || []).some((topic) => topic.id === selectedId)) {
            return selectedId;
          }

          const selectedMemory = (raw.memories || []).find((memory) => memory.id === selectedId);
          return selectedMemory ? selectedMemory.topicNodeId : null;
        }

        function matchesFilters(node) {
          if (state.filters.nodeType === "topics" && node.kind !== "topic") return false;
          if (state.filters.nodeType === "memories" && node.kind !== "memory") return false;
          if (state.filters.lifecycle !== "all" && node.lifecycle !== state.filters.lifecycle) return false;
          if (state.filters.tag) {
            const haystack = (node.tags || []).join(" ").toLowerCase();
            if (!haystack.includes(state.filters.tag)) return false;
          }
          return true;
        }

        function renderGraphSurface(graph) {
          const surface = graph.mode === "overview" ? renderGraphOverview(graph) : renderGraphSvg(graph);
          return renderGraphNavigator(graph) + surface;
        }

        function renderGraphNavigator(graph) {
          const selectedDisabled = state.selectedGraphNodeId ? "" : " disabled";
          return '<div class="graph-navigator" data-graph-navigator>' +
            '<div class="summary-strip">' +
              '<span>' + escapeHtml(graphModeLabel(graph)) + '</span>' +
              '<span>edges: ' + escapeHtml(state.graphEdgeMode) + '</span>' +
              '<span>view: ' + escapeHtml(state.graphViewMode) + '</span>' +
            '</div>' +
            '<div class="graph-nav-actions">' +
              '<button class="icon-button" type="button" data-graph-nav-action="overview" title="Clear graph selection and return to overview"' + selectedDisabled + '>Reset view</button>' +
            '</div>' +
          '</div>';
        }

        function graphModeLabel(graph) {
          if (graph.mode === "topic-focus") return "Topic focus";
          if (graph.mode === "memory-focus") return "Memory focus";
          return state.graphViewMode === "clusters" ? "Cluster overview" : "Overview";
        }

        function handleGraphNavigatorAction(action) {
          if (action === "overview") {
            resetGraphSelection();
          }
        }

        function renderGraphOverview(graph) {
          const nodes = graph.topicNodes.length > 0 ? graph.topicNodes : graph.memoryNodes;
          const title = graph.topicNodes.length > 0 ? "Topic overview" : "Memory overview";
          const hint = graph.topicNodes.length > 0
            ? "Select a topic to inspect its memory neighborhood."
            : "Select a memory to inspect its source topic.";
          if (state.graphViewMode === "clusters" && graph.topicNodes.length > 0) {
            return renderGraphClusters(graph, title, hint);
          }
          return '<div class="graph-overview" data-graph-overview>' +
            '<div class="graph-overview-header">' +
              '<span class="graph-overview-title">' + title + '</span>' +
              '<span class="subtle">' + hint + '</span>' +
            '</div>' +
            '<div class="graph-overview-grid">' + nodes.map((node) => renderOverviewNode(node, graph)).join("") + '</div>' +
          '</div>';
        }

        function renderGraphClusters(graph, title, hint) {
          const clusters = graphClusters(graph);
          return '<div class="graph-overview" data-graph-overview>' +
            '<div class="graph-overview-header">' +
              '<span class="graph-overview-title">' + title + '</span>' +
              '<span class="subtle">' + hint + '</span>' +
            '</div>' +
            '<div class="graph-cluster-list">' + clusters.map((cluster) => renderGraphCluster(cluster, graph)).join("") + '</div>' +
          '</div>';
        }

        function graphClusters(graph) {
          const clustersByKey = new Map();
          graph.topicNodes.forEach((node) => {
            const key = graphClusterKey(node);
            const cluster = clustersByKey.get(key) || { key, label: topicClusterLabel(node.raw || node), nodes: [], memories: 0, suppressed: 0 };
            cluster.nodes.push(node);
            cluster.memories += graph.topicMemoryCounts.get(node.id) || 0;
            if (node.lifecycle === "suppressed") cluster.suppressed += 1;
            clustersByKey.set(key, cluster);
          });
          return Array.from(clustersByKey.values()).sort((left, right) => right.nodes.length - left.nodes.length || left.label.localeCompare(right.label));
        }

        function graphClusterKey(node) {
          return (node.raw || node).clusterId || "unclustered";
        }

        function topicClusterLabel(topic) {
          const clusters = (state.graph && state.graph.clusters) || (state.tables && state.tables.clusters) || [];
          const cluster = clusters.find((item) => item.id === topic.clusterId && item.sessionId === topic.sessionId);
          return cluster ? cluster.label : "Unclustered";
        }

        function renderGraphCluster(cluster, graph) {
          const collapsed = Boolean(state.collapsedGraphClusters[cluster.key]);
          return '<section class="graph-cluster">' +
            '<button class="graph-cluster-header" type="button" data-graph-cluster-toggle="' + escapeAttribute(cluster.key) + '" aria-expanded="' + String(!collapsed) + '">' +
              '<span class="graph-cluster-title">' + escapeHtml(cluster.label) + '</span>' +
              '<span class="summary-strip">' +
                '<span>' + numberText(cluster.nodes.length) + ' topics</span>' +
                '<span>' + numberText(cluster.memories) + ' memories</span>' +
                '<span>' + numberText(cluster.suppressed) + ' suppressed</span>' +
              '</span>' +
            '</button>' +
            (collapsed ? "" : '<div class="graph-cluster-body"><div class="graph-overview-grid">' + cluster.nodes.map((node) => renderOverviewNode(node, graph)).join("") + '</div></div>') +
          '</section>';
        }

        function toggleGraphCluster(key) {
          if (!key) return;
          state.collapsedGraphClusters[key] = !state.collapsedGraphClusters[key];
          renderGraph();
        }

        function renderOverviewNode(node, graph) {
          const selected = node.id === state.selectedGraphNodeId ? " selected" : "";
          const hovered = node.id === state.hoveredGraphNodeId ? " hovered" : "";
          const searchMatch = graph.searchMatchIds.has(node.id) ? " search-match" : "";
          const searchParent = graph.searchParentIds.has(node.id) && !searchMatch ? " search-parent" : "";
          const searchActive = graph.activeSearchId === node.id ? " search-active" : "";
          const badge = lifecycleBadge(node.lifecycle);
          const aria = node.kind + " " + node.title + ", " + node.lifecycle;
          const meta = overviewNodeMeta(node, graph);
          return '<button class="overview-node node-card ' + node.kind + selected + hovered + searchMatch + searchParent + searchActive + '" type="button" aria-label="' + escapeAttribute(aria) + '" data-graph-node-id="' + escapeAttribute(node.id) + '">' +
            '<span class="overview-accent ' + node.kind + '"></span>' +
            '<span class="overview-node-body">' +
              '<span class="overview-node-topline">' +
                '<span class="overview-node-kind">' + escapeHtml(node.kind) + '</span>' +
                (node.kind === "topic" && node.raw && node.raw.pinned ? '<span class="badge">Pinned</span>' : "") +
                '<span class="badge">' + escapeHtml(badge.label) + '</span>' +
              '</span>' +
              '<span class="overview-node-title">' + escapeHtml(truncate(node.title, 54)) + '</span>' +
              '<span class="overview-node-summary">' + escapeHtml(truncate(node.subtitle, 96)) + '</span>' +
              '<span class="overview-node-meta">' + meta.map((item) => '<span>' + escapeHtml(item) + '</span>').join("") + '</span>' +
            '</span>' +
          '</button>';
        }

        function overviewNodeMeta(node, graph) {
          const raw = node.raw || {};
          if (node.kind === "topic") {
            const memoryCount = graph.topicMemoryCounts.get(node.id) || 0;
            const edgeCount = graph.topicEdgeCounts.get(node.id) || 0;
            const range = Array.isArray(raw.messageRange) ? raw.messageRange.join("-") : "unknown range";
            return [
              numberText(memoryCount) + " memories",
              numberText(edgeCount) + " links",
              "range " + range
            ];
          }

          return [
            raw.memoryType || "memory",
            "quality " + (raw.quality == null ? "unknown" : JSON.stringify(raw.quality))
          ];
        }

        function renderGraphSvg(graph) {
          const rowGap = 132;
          const nodeWidth = 330;
          const nodeHeight = 96;
          const topicX = 56;
          const memoryX = graph.topicNodes.length === 0 ? topicX : 520;
          const topicPositions = new Map();
          const memoryPositions = new Map();

          graph.topicNodes.forEach((node, index) => topicPositions.set(node.id, {
            x: topicX,
            y: 42 + index * rowGap
          }));
          graph.memoryNodes.forEach((node, index) => memoryPositions.set(node.id, {
            x: memoryX,
            y: 42 + index * rowGap
          }));

          const positions = new Map([...topicPositions, ...memoryPositions]);
          const height = Math.max(560, 160 + Math.max(graph.topicNodes.length, graph.memoryNodes.length) * rowGap);
          const width = 920;
          const activeId = state.hoveredGraphNodeId || state.selectedGraphNodeId;
          const connectedIds = connectedNodeIds(graph, activeId);
          const topicEdges = graphEdgesForMode(graph.topicEdges, activeId, (edge) => [edge.srcId, edge.dstId]);
          const memoryEdges = graphEdgesForMode(graph.memoryEdges, activeId, (edge) => [edge.sourceId, edge.targetId]);
          const edgeMarkup = renderGraphMarkers() +
            topicEdges.map((edge) => renderCurve(edge.srcId, edge.dstId, positions, nodeWidth, nodeHeight, edge.attachment ? "attachment" : "topic", activeId))
            .concat(memoryEdges.map((edge) => renderCurve(edge.sourceId, edge.targetId, positions, nodeWidth, nodeHeight, "memory", activeId)))
            .join("");
          const nodeMarkup = graph.nodes.map((node) => renderNode(node, positions.get(node.id), nodeWidth, nodeHeight, activeId, connectedIds, graph)).join("");

          return '<svg class="graph-svg" role="img" aria-label="Session memory graph" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
            edgeMarkup +
            nodeMarkup +
          '</svg>';
        }

        function graphEdgesForMode(edges, activeId, idsForEdge) {
          if (state.graphEdgeMode === "hidden") return [];
          if (state.graphEdgeMode === "all" || !activeId) return edges;
          return edges.filter((edge) => idsForEdge(edge).includes(activeId));
        }

        function renderGraphMarkers() {
          return '<defs>' +
            '<marker id="graph-arrow-topic" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#8ea0b8"></path></marker>' +
            '<marker id="graph-arrow-memory" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#b89a71"></path></marker>' +
            '<marker id="graph-arrow-attachment" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#94a3b8"></path></marker>' +
          '</defs>';
        }

        function renderCurve(fromId, toId, positions, nodeWidth, nodeHeight, kind, activeId) {
          const from = positions.get(fromId);
          const to = positions.get(toId);
          if (!from || !to) return "";
          const x1 = from.x + nodeWidth;
          const y1 = from.y + nodeHeight / 2;
          const x2 = to.x;
          const y2 = to.y + nodeHeight / 2;
          const curve = Math.max(80, Math.abs(x2 - x1) * 0.42);
          const highlightClass = activeId && (fromId === activeId || toId === activeId) ? " highlighted" : activeId ? " dimmed" : "";
          const edgeKind = kind;
          return '<path class="edge-line ' + edgeKind + highlightClass + '" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve) + ' ' + y1 + ', ' + (x2 - curve) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"></path>';
        }

        function renderNode(node, position, width, height, activeId, connectedIds, graph) {
          if (!position) return "";
          const selected = node.id === state.selectedGraphNodeId ? " selected" : "";
          const hovered = node.id === state.hoveredGraphNodeId ? " hovered" : "";
          const searchMatch = graph.searchMatchIds.has(node.id) ? " search-match" : "";
          const searchParent = graph.searchParentIds.has(node.id) && !searchMatch ? " search-parent" : "";
          const searchActive = graph.activeSearchId === node.id ? " search-active" : "";
          const dimmed = activeId && !connectedIds.has(node.id) ? " dimmed" : "";
          const badge = lifecycleBadge(node.lifecycle);
          const meta = graphNodeMeta(node);
          const aria = node.kind + " " + node.title + ", " + node.lifecycle;
          return '<g class="node-card ' + node.kind + selected + hovered + searchMatch + searchParent + searchActive + dimmed + '" tabindex="0" role="button" aria-label="' + escapeAttribute(aria) + '" data-graph-node-id="' + escapeAttribute(node.id) + '">' +
            '<rect class="node-surface" x="' + position.x + '" y="' + position.y + '" width="' + width + '" height="' + height + '" rx="12"></rect>' +
            '<rect class="accent-rail ' + node.kind + '" x="' + position.x + '" y="' + position.y + '" width="7" height="' + height + '" rx="3"></rect>' +
            '<text class="node-kind" x="' + (position.x + 18) + '" y="' + (position.y + 20) + '">' + escapeHtml(node.kind) + '</text>' +
            '<rect class="status-badge ' + badge.className + '" x="' + (position.x + width - badge.width - 14) + '" y="' + (position.y + 10) + '" width="' + badge.width + '" height="20" rx="10"></rect>' +
            '<text class="badge-text" x="' + (position.x + width - badge.width - 4) + '" y="' + (position.y + 24) + '">' + escapeHtml(badge.label) + '</text>' +
            '<text class="node-title" x="' + (position.x + 18) + '" y="' + (position.y + 43) + '">' + escapeHtml(truncate(node.title, 38)) + '</text>' +
            '<text x="' + (position.x + 18) + '" y="' + (position.y + 63) + '">' + escapeHtml(truncate(node.subtitle, 48)) + '</text>' +
            '<text class="node-meta" x="' + (position.x + 18) + '" y="' + (position.y + 84) + '">' + escapeHtml(meta) + '</text>' +
          '</g>';
        }

        function connectedNodeIds(graph, activeId) {
          const ids = new Set();
          if (!activeId) return ids;
          ids.add(activeId);
          graph.topicEdges.forEach((edge) => {
            if (edge.srcId === activeId) ids.add(edge.dstId);
            if (edge.dstId === activeId) ids.add(edge.srcId);
          });
          graph.memoryEdges.forEach((edge) => {
            if (edge.sourceId === activeId) ids.add(edge.targetId);
            if (edge.targetId === activeId) ids.add(edge.sourceId);
          });
          return ids;
        }

        function lifecycleBadge(lifecycle) {
          const label = lifecycle || "active";
          return {
            label,
            className: label,
            width: Math.max(58, label.length * 7 + 18)
          };
        }

        function graphNodeMeta(node) {
          const raw = node.raw || {};
          if (node.kind === "topic") {
            const range = Array.isArray(raw.messageRange) ? raw.messageRange.join("-") : "unknown range";
            return "range " + range + " · " + numberText((node.tags || []).length) + " tags";
          }

          const quality = raw.quality == null ? "unknown" : JSON.stringify(raw.quality);
          return (raw.memoryType || "memory") + " · quality " + quality;
        }

        function selectGraphNode(nodeId, graph) {
          if (!nodeId) return;
          const entity = resolveGraphEntity(nodeId, graph);
          if (entity && entity.kind === "topic" && state.expandedMemoriesTopicId !== nodeId) {
            state.expandedMemoriesTopicId = null;
          }
          state.selectedGraphNodeId = nodeId;
          state.selectedEntity = entity
            ? { kind: entity.kind, id: entity.id, source: "graph" }
            : null;
        }

        function resolveGraphEntity(nodeId, graph) {
          if (!nodeId) return null;

          const displayNode = graph && graph.nodes
            ? graph.nodes.find((candidate) => candidate.id === nodeId)
            : null;
          if (displayNode) return { kind: displayNode.kind, id: displayNode.id };

          if (((state.graph && state.graph.nodes) || []).some((topic) => topic.id === nodeId)) {
            return { kind: "topic", id: nodeId };
          }

          if (((state.graph && state.graph.memories) || []).some((memory) => memory.id === nodeId)) {
            return { kind: "memory", id: nodeId };
          }

          return null;
        }

        function renderDetailsPanel() {
          const node = resolveSelectedEntity();
          if (!node) {
            if (state.activeTab === "graph" && state.graph) {
              renderGraphOverviewDetails();
              return;
            }
            const noun = state.activeTab === "graph" ? "node in the graph" : "entity";
            elements.detailsPanel.innerHTML = '<p class="subtle">Select a ' + noun + ' to inspect its metadata.</p>';
            return;
          }

          renderEntityDetails(node);
        }

        function renderGraphOverviewDetails() {
          const topics = (state.graph.nodes || []).length;
          const memories = (state.graph.memories || []).length;
          const topicEdges = (state.graph.edges || []).length;
          const memoryEdges = (state.graph.memoryEdges || []).length;
          const suppressedTopics = (state.graph.nodes || []).filter((node) => node.suppressed).length;
          const inactiveMemories = (state.graph.memories || []).filter((memory) => memoryLifecycle(memory) !== "active").length;
          elements.detailsPanel.innerHTML =
            detailSection("Session overview",
              '<dl class="metadata-grid">' +
                detailRow("Topics", numberText(topics)) +
                detailRow("Memories", numberText(memories)) +
                detailRow("Topic edges", numberText(topicEdges)) +
                detailRow("Memory edges", numberText(memoryEdges)) +
                detailRow("Suppressed topics", numberText(suppressedTopics)) +
                detailRow("Inactive memories", numberText(inactiveMemories)) +
              '</dl>') +
            detailSection("Graph mode", '<p class="subtle">Overview mode shows compact cards first. Select a topic or memory to inspect its focused neighborhood.</p>');
        }

        function resolveSelectedEntity() {
          const selectedEntity = state.selectedEntity || (
            state.activeTab === "graph" && state.selectedGraphNodeId
              ? resolveGraphEntity(state.selectedGraphNodeId, null)
              : null
          );
          if (!selectedEntity) return null;
          const tables = normalizeTables(state.tables);

          if (selectedEntity.kind === "topic") {
            const raw = ((state.graph && state.graph.nodes) || []).find((node) => node.id === selectedEntity.id)
              || ((state.tables && state.tables.topics) || []).find((node) => node.id === selectedEntity.id);
            if (!raw) return null;
            return {
              id: raw.id,
              kind: "topic",
              title: raw.label || raw.id,
              subtitle: raw.summary || "",
              tags: raw.tags || [],
              lifecycle: raw.suppressed ? "suppressed" : "active",
              raw
            };
          }

          if (selectedEntity.kind === "memory") {
            const raw = ((state.graph && state.graph.memories) || []).find((memory) => memory.id === selectedEntity.id)
              || ((state.tables && state.tables.memories) || []).find((memory) => memory.id === selectedEntity.id);
            if (!raw) return null;
            return {
              id: raw.id,
              kind: "memory",
              title: raw.subject ? raw.subject + " " + raw.predicate : raw.id,
              subtitle: raw.value || "",
              tags: raw.tags || [],
              lifecycle: memoryLifecycle(raw),
              raw
            };
          }

          if (selectedEntity.kind === "segment") {
            return tables.segments.find((segment) => segment.id === selectedEntity.id) || null;
          }

          if (selectedEntity.kind === "message") {
            return tables.messages.find((message) => message.id === selectedEntity.id) || null;
          }

          return null;
        }

        function renderEntityDetails(node) {
          if (!node) {
            renderDetailsPanel();
            return;
          }

          elements.detailsPanel.innerHTML = node.kind === "topic"
            ? renderTopicDetails(node)
            : node.kind === "memory"
              ? renderMemoryDetails(node)
              : node.kind === "segment"
                ? renderSegmentDetails(node)
                : renderMessageDetails(node);

          elements.detailsPanel.querySelectorAll("[data-detail-node-id]").forEach((button) => {
            button.addEventListener("click", () => {
              const id = button.getAttribute("data-detail-node-id");
              const kind = ((state.graph && state.graph.nodes) || (state.tables && state.tables.topics) || []).some((topic) => topic.id === id) ? "topic" : "memory";
              if (kind === "topic" && state.expandedMemoriesTopicId !== id) state.expandedMemoriesTopicId = null;
              state.selectedGraphNodeId = id;
              state.selectedEntity = { kind, id, source: state.activeTab === "tables" ? "tables" : "graph" };
              state.actionStatus = null;
              if (state.activeTab === "graph") {
                renderGraph();
              } else {
                renderWorkspace();
              }
            });
          });

          elements.detailsPanel.querySelectorAll("[data-lifecycle-action]").forEach((button) => {
            button.addEventListener("click", () => runLifecycleAction(node, button.getAttribute("data-lifecycle-action")));
          });
          elements.detailsPanel.querySelectorAll("[data-graft-action]").forEach((button) => {
            button.addEventListener("click", () => runGraftUiAction(node, button.getAttribute("data-graft-action"), button));
          });
          elements.detailsPanel.querySelectorAll("[data-graft-target]").forEach((input) => {
            input.addEventListener("change", () => {
              const targetId = input.getAttribute("data-graft-target");
              state.graft.targetSessionIds = input.checked
                ? Array.from(new Set(state.graft.targetSessionIds.concat(targetId)))
                : state.graft.targetSessionIds.filter((id) => id !== targetId);
              state.graft.preview = null;
              state.graft.result = null;
              renderEntityDetails(node);
            });
          });
          elements.detailsPanel.querySelectorAll("[data-memory-list-toggle]").forEach((button) => {
            button.addEventListener("click", () => {
              const topicId = button.getAttribute("data-memory-list-toggle");
              state.expandedMemoriesTopicId = state.expandedMemoriesTopicId === topicId ? null : topicId;
              renderEntityDetails(node);
            });
          });
        }

        function renderTopicDetails(node) {
          const raw = node.raw || {};
          const connectedMemories = (((state.graph && state.graph.memories) || (state.tables && state.tables.memories) || [])).filter((memory) => memory.topicNodeId === node.id);
          const lifecycle = raw.suppressed
            ? "Suppressed" + (raw.suppressedAt ? " since " + formatDate(raw.suppressedAt) : "")
            : "Active";
          const sourceRows = [
            detailTextRow("Source", raw.source || "Not recorded"),
            detailTextRow("Segment", raw.segmentId || "Unknown"),
            detailTextRow("Message range", Array.isArray(raw.messageRange) ? raw.messageRange.join(" to ") : "Unknown"),
            detailTextRow("Agent", raw.agentId || "None"),
            detailTextRow("Fleet", raw.fleetId || "None")
          ].join("");

          return detailSection("Topic", [
            detailTextRow("Label", raw.label || node.title),
            detailTextRow("Domain", topicClusterLabel(raw)),
            detailTextRow("Summary", raw.summary || "None"),
            detailRow("Tags", tagsMarkup(node.tags)),
            detailTextRow("Lifecycle", lifecycle),
            detailTextRow("Pinned", raw.pinned ? "Yes" + (raw.pinnedAt ? " since " + formatDate(raw.pinnedAt) : "") : "No"),
            detailTextRow("Topic order", raw.topicOrder == null ? "Unknown" : String(raw.topicOrder)),
            detailTextRow("Created", formatDate(raw.createdAt))
          ].join("")) +
          detailSection("Source metadata", sourceRows) +
          (graftOriginForTopic(node.id) ? detailSection("Graft provenance", [
            detailTextRow("Source session", graftOriginForTopic(node.id).sourceSessionId),
            detailTextRow("Source topic", graftOriginForTopic(node.id).sourceNodeId),
            detailTextRow("Grafted", formatDate(graftOriginForTopic(node.id).graftedAt)),
            detailTextRow("Synchronization", "None — this is an independent copy")
          ].join("")) : "") +
          detailSection("Connected memories", connectedMemoriesMarkup(node.id, connectedMemories)) +
          renderActionSection(node);
        }

        function renderMemoryDetails(node) {
          const raw = node.raw || {};
          const lifecycleFlags = memoryLifecycleFlags(raw);
          const relationshipMarkup = state.graph ? memoryRelationshipsMarkup(node.id) : '<p class="subtle">Load the Graph tab to inspect memory relationships.</p>';

          return detailSection("Memory", [
            detailTextRow("Subject", raw.subject || "None"),
            detailTextRow("Predicate", raw.predicate || "None"),
            detailTextRow("Value", raw.value || "None"),
            detailTextRow("Quality", raw.quality == null ? "Unknown" : JSON.stringify(raw.quality)),
            detailTextRow("Memory type", raw.memoryType || "Unknown"),
            detailTextRow("Source type", raw.sourceType || "Unknown"),
            detailRow("Tags", tagsMarkup(node.tags)),
            detailTextRow("Created", formatDate(raw.createdAt))
          ].join("")) +
          detailSection("Lifecycle", [
            detailRow("Flags", tagsMarkup(lifecycleFlags)),
            detailTextRow("Forgotten at", raw.forgottenAt ? formatDate(raw.forgottenAt) : "Not forgotten"),
            detailTextRow("Superseded by", raw.supersededBy || "None")
          ].join("")) +
          detailSection("Source metadata", [
            detailTextRow("Source", raw.source || "Not recorded"),
            detailTextRow("Title", raw.sourceTitle || "Not recorded"),
            detailTextRow("URL", raw.sourceUrl || "Not recorded"),
            detailTextRow("Topic node", raw.topicNodeId || "Unknown"),
            detailTextRow("Agent", raw.agentId || "None"),
            detailTextRow("Fleet", raw.fleetId || "None")
          ].join("")) +
          detailSection("Relationships", relationshipMarkup) +
          renderActionSection(node);
        }

        function renderSegmentDetails(node) {
          const raw = node.raw || {};
          const topics = (((state.graph && state.graph.nodes) || (state.tables && state.tables.topics) || [])).filter((topic) => topic.segmentId === node.id);

          return detailSection("Segment", [
            detailTextRow("ID", raw.id || node.id),
            detailTextRow("Order", raw.topicOrder == null ? "Unknown" : String(raw.topicOrder)),
            detailTextRow("Message range", formatSegmentRange(raw)),
            detailTextRow("Drift score", raw.driftScore == null ? "Unknown" : String(raw.driftScore)),
            detailTextRow("Created", formatDate(raw.createdAt)),
            detailTextRow("Related topics", String(topics.length))
          ].join("")) +
          detailSection("Related topics", connectedTopicsMarkup(topics));
        }

        function renderMessageDetails(node) {
          const raw = node.raw || {};
          const content = raw.content || "";
          const index = node.index == null ? messageIndexFromId(node.id) : node.index;
          const segment = (((state.tables && state.tables.segments) || [])).find((candidate) =>
            index != null && candidate.startIndex <= index && candidate.endIndex >= index
          );

          return detailSection("Message", [
            detailTextRow("Index", index == null ? "Unknown" : String(index)),
            detailTextRow("Role", raw.role || "Unknown"),
            detailTextRow("Approx length", numberText(content.length) + " chars"),
            detailTextRow("Related segment", segment ? segment.id : "None")
          ].join("")) +
          detailSection("Content", '<p class="detail-value">' + escapeHtml(content || "No content") + '</p>');
        }

        function renderActionSection(node) {
          const status = state.actionStatus && state.actionStatus.nodeId === node.id
            ? '<div class="action-status ' + state.actionStatus.kind + '" role="' + (state.actionStatus.kind === "error" ? "alert" : "status") + '" aria-live="polite">' + escapeHtml(state.actionStatus.message) + '</div>'
            : "";
          let action = "";

          if (node.kind === "topic" && !node.raw.suppressed) {
            action = '<button class="icon-button" type="button" data-lifecycle-action="' + (node.raw.pinned ? "unpin" : "pin") + '"' + (state.actionPending ? " disabled" : "") + '>' + (node.raw.pinned ? "Unpin topic" : "Pin topic") + '</button>' +
              '<button class="icon-button" type="button" data-lifecycle-action="suppress"' + (state.actionPending ? " disabled" : "") + '>Suppress topic</button>' +
              '<button class="primary-button" type="button" data-graft-action="open"' + (state.actionPending ? " disabled" : "") + '>Graft to session</button>';
          }
          if (node.kind === "topic" && graftOriginForTopic(node.id)) {
            action += '<button class="danger-button" type="button" data-graft-action="remove"' + (state.actionPending ? " disabled" : "") + '>Remove graft</button>';
          }

          const graftPanel = state.graft.topicId === node.id ? renderGraftPanel() : "";
          if (!action && !status && !graftPanel) return "";
          return detailSection("Actions", status + (action ? '<div class="detail-actions">' + action + '</div>' : "") + graftPanel);
        }

        function graftOriginForTopic(topicId) {
          return (((state.graph && state.graph.graftRegistry) || [])).find((entry) => entry.nodeId === topicId) || null;
        }

        function renderGraftPanel() {
          if (state.graft.result) {
            return '<div class="graft-panel">' + renderGraftResult() +
              '<div class="detail-actions"><button class="primary-button" type="button" data-graft-action="done">Done</button></div></div>';
          }
          const targets = state.sessions.filter((session) => session.id !== state.selectedSessionId);
          const selected = new Set(state.graft.targetSessionIds);
          const targetMarkup = targets.length
            ? targets.map((session) => '<label class="graft-target"><input type="checkbox" data-graft-target="' + escapeAttribute(session.id) + '"' + (selected.has(session.id) ? " checked" : "") + (state.graft.loading ? " disabled" : "") + '><span><strong>' + escapeHtml(sessionDisplayLabel(session)) + '</strong><br><span class="subtle">' + escapeHtml(session.id) + ' · ' + numberText(session.topicCount) + ' topics</span></span></label>').join("")
            : '<p class="subtle">No other sessions are available.</p>';
          const allDuplicates = state.graft.preview && state.graft.preview.targets.every((target) => target.duplicate);
          return '<div class="graft-panel">' +
            '<p class="subtle">Copies this topic and its active memories. Later source changes are not synchronized.</p>' +
            '<div class="graft-target-list">' + targetMarkup + '</div>' +
            (state.graft.error ? '<div class="action-status error" role="alert">' + escapeHtml(state.graft.error) + '</div>' : "") +
            renderGraftPreview() + renderGraftResult() +
            '<div class="detail-actions graft-footer"><button class="icon-button" type="button" data-graft-action="cancel"' + (state.graft.loading ? " disabled" : "") + '>Cancel</button>' +
            (!state.graft.preview
              ? '<button class="primary-button" type="button" data-graft-action="preview"' + (!selected.size || state.graft.loading ? " disabled" : "") + '>' + (state.graft.loading ? "Loading…" : "Review graft") + '</button>'
              : '<button class="primary-button" type="button" data-graft-action="confirm"' + (state.graft.loading || allDuplicates ? " disabled" : "") + '>' + (state.graft.loading ? "Copying…" : "Graft to " + numberText(state.graft.preview.targets.length) + " session" + (state.graft.preview.targets.length === 1 ? "" : "s")) + '</button>') +
            '</div></div>';
        }

        function renderGraftPreview() {
          const preview = state.graft.preview;
          if (!preview) return "";
          const active = preview.activeMemories || [];
          const omitted = preview.omittedMemories || [];
          const topicTitle = (preview.topic && preview.topic.label) || preview.topic.id;
          const memoriesMarkup = active.length
            ? '<div class="graft-memory-list">' + active.map((memory) => '<div class="graft-memory-row"><span class="graft-memory-check" aria-hidden="true">✓</span><span>' + escapeHtml(graftMemoryTitle(memory)) + '</span></div>').join("") + '</div>'
            : '<p class="subtle">No active memories will be copied.</p>';
          const omittedMarkup = omitted.length
            ? '<details><summary>View ' + numberText(omitted.length) + ' omitted memor' + (omitted.length === 1 ? 'y' : 'ies') + '</summary><div class="graft-memory-list">' + omitted.map((item) => '<div class="graft-memory-row"><span>' + escapeHtml(graftMemoryTitle(item.memory)) + '</span><span class="subtle">' + escapeHtml(item.reasons.join(", ")) + '</span></div>').join("") + '</div></details>'
            : "";
          const destinationsMarkup = '<div class="graft-destinations">' + preview.targets.map((target) => {
            const session = state.sessions.find((candidate) => candidate.id === target.targetSessionId) || { id: target.targetSessionId };
            return '<div class="graft-destination"><span class="graft-destination-name">' + escapeHtml(sessionDisplayLabel(session)) + '</span>' +
              '<span class="graft-status ' + (target.duplicate ? 'skip' : 'ready') + '">' + (target.duplicate ? 'Already grafted · skip' : 'Ready') + '</span></div>';
          }).join("") + '</div>';
          return '<section class="graft-review" aria-label="Graft confirmation review">' +
            '<header class="graft-review-header"><span class="graft-review-title">Review graft</span><span class="graft-review-subtitle">Confirm what will be copied to the selected session' + (preview.targets.length === 1 ? '' : 's') + '.</span></header>' +
            '<div class="graft-review-body">' +
              '<div class="graft-review-section"><span class="graft-eyebrow">Source topic</span><span class="graft-topic-title">' + escapeHtml(topicTitle) + '</span><div class="graft-counts"><span class="graft-count">' + numberText(active.length) + ' included</span>' + (omitted.length ? '<span class="graft-count omitted">' + numberText(omitted.length) + ' omitted</span>' : '') + '</div></div>' +
              '<div class="graft-review-section"><span class="graft-eyebrow">Memories</span>' + memoriesMarkup + omittedMarkup + '</div>' +
              '<div class="graft-review-section"><span class="graft-eyebrow">Destination' + (preview.targets.length === 1 ? '' : 's') + '</span>' + destinationsMarkup + '</div>' +
              '<div class="graft-review-section"><div class="graft-copy-note">This creates an independent copy. Later source changes will not be synchronized.</div></div>' +
            '</div></section>';
        }

        function renderGraftResult() {
          const result = state.graft.result;
          if (!result) return "";
          const outcomes = result.results || [];
          const copied = outcomes.filter((item) => item.status === "copied").length;
          const failed = outcomes.filter((item) => item.status === "failed").length;
          const heading = failed > 0 && failed === outcomes.length ? "Graft failed"
            : copied === 0 ? "No topics copied"
              : failed > 0 ? "Graft completed with issues"
                : "Graft completed";
          const kind = failed > 0 && failed === outcomes.length ? "error" : failed > 0 || copied === 0 ? "warning" : "success";
          return '<div class="action-status ' + kind + '" role="status"><strong>' + heading + '</strong><ul>' + outcomes.map((item) =>
            '<li>' + escapeHtml(sessionDisplayLabel(state.sessions.find((session) => session.id === item.targetSessionId) || { id: item.targetSessionId })) + ': ' + escapeHtml(item.status) +
            (item.targetTopicId ? ' <button class="icon-button" type="button" data-graft-action="navigate" data-target-session="' + escapeAttribute(item.targetSessionId) + '" data-target-topic="' + escapeAttribute(item.targetTopicId) + '">Open topic</button>' : '') +
            (item.error ? ' — ' + escapeHtml(item.error) : '') + '</li>').join("") + '</ul></div>';
        }

        async function runGraftUiAction(node, action, button) {
          if (state.actionPending || state.graft.loading) return;
          if (action === "open") {
            state.graft = { topicId: node.id, targetSessionIds: [], preview: null, result: null, loading: false, error: null };
            renderEntityDetails(node);
            return;
          }
          if (action === "cancel" || action === "done") {
            state.graft = { topicId: null, targetSessionIds: [], preview: null, result: null, loading: false, error: null };
            renderEntityDetails(node);
            return;
          }
          if (action === "navigate") {
            const targetSessionId = button.getAttribute("data-target-session");
            const targetTopicId = button.getAttribute("data-target-topic");
            if (await loadGraph(targetSessionId)) {
              state.selectedGraphNodeId = targetTopicId;
              state.selectedEntity = { kind: "topic", id: targetTopicId, source: "graph" };
              renderGraph();
            }
            return;
          }
          if (action === "remove") {
            if (!window.confirm("Remove this grafted copy? The source topic will not be affected.")) return;
            state.actionPending = true;
            try {
              await fetchJson("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/grafts/" + encodeURIComponent(node.id) + "/remove", { method: "POST" });
              state.selectedGraphNodeId = null;
              state.selectedEntity = null;
              await loadGraph(state.selectedSessionId);
            } catch (error) {
              state.actionStatus = { nodeId: node.id, kind: "error", message: error.message || String(error) };
            } finally {
              state.actionPending = false;
              renderWorkspace();
            }
            return;
          }
          if (action !== "preview" && action !== "confirm") return;
          state.graft.loading = true;
          state.graft.error = null;
          renderEntityDetails(node);
          const url = "/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/grafts" + (action === "preview" ? "/preview" : "");
          try {
            const response = await fetchJson(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ topicIds: [node.id], targetSessionIds: state.graft.targetSessionIds, duplicatePolicy: "skip" })
            });
            if (action === "preview") state.graft.preview = response;
            else { state.graft.result = response; await loadSessions(); }
          } catch (error) {
            state.graft.error = error.message || String(error);
          } finally {
            state.graft.loading = false;
            renderEntityDetails(node);
          }
        }

        function graftMemoryTitle(memory) {
          const subject = String((memory && memory.subject) || "").trim();
          const predicate = String((memory && memory.predicate) || "").trim();
          return [subject, predicate].filter(Boolean).join(" ") || "Memory";
        }

        async function runLifecycleAction(node, action) {
          if (!state.selectedSessionId || state.actionPending) return;
          if (node.kind !== "topic" || !["suppress", "pin", "unpin"].includes(action)) return;

          const sessionId = state.selectedSessionId;
          const previousPinned = Boolean(node.raw && node.raw.pinned);
          const previousPinnedAt = node.raw && node.raw.pinnedAt;
          if (action === "pin" || action === "unpin") {
            node.raw.pinned = action === "pin";
            node.raw.pinnedAt = action === "pin" ? new Date().toISOString() : null;
          }
          const url = action === "suppress"
            ? "/api/sessions/" + encodeURIComponent(sessionId) + "/nodes/" + encodeURIComponent(node.id) + "/suppress"
            : "/api/sessions/" + encodeURIComponent(sessionId) + "/topics/" + encodeURIComponent(node.id) + "/pin";
          state.actionPending = true;
          state.actionStatus = null;
          renderEntityDetails(node);

          try {
            const result = await fetchJson(url, { method: action === "pin" ? "PUT" : action === "unpin" ? "DELETE" : "POST" });
            state.actionStatus = {
              nodeId: node.id,
              kind: "success",
              message: action === "pin" ? "Topic pinned for future invocations."
                : action === "unpin" ? "Topic unpinned."
                  : lifecycleActionMessage(action, result.changed)
            };
            const refreshed = state.activeTab === "tables"
              ? await loadTables(sessionId, { force: true })
              : await loadGraph(sessionId, { preserveSelection: true });
            if (!refreshed) {
              state.actionStatus = {
                nodeId: node.id,
                kind: "error",
                message: "The lifecycle action completed, but the workspace could not be refreshed."
              };
            }
          } catch (error) {
            if (action === "pin" || action === "unpin") {
              node.raw.pinned = previousPinned;
              node.raw.pinnedAt = previousPinnedAt;
            }
            state.actionStatus = {
              nodeId: node.id,
              kind: "error",
              message: error.message || String(error)
            };
          } finally {
            state.actionPending = false;
            renderGraph();
          }
        }

        function lifecycleActionMessage(action, changed) {
          if (!changed) return "No change was needed; the lifecycle state was already up to date.";
          return "Topic suppressed. The graph and node details have been refreshed.";
        }

        function connectedMemoriesMarkup(topicId, memories) {
          const expanded = state.expandedMemoriesTopicId === topicId;
          const countLabel = numberText(memories.length) + " memor" + (memories.length === 1 ? "y" : "ies");
          const toggle = memories.length
            ? '<button class="icon-button connected-memory-toggle" type="button" data-memory-list-toggle="' + escapeAttribute(topicId) + '" aria-expanded="' + String(expanded) + '">' + (expanded ? "Hide memories" : "Show memories") + '</button>'
            : "";
          const summary = '<div class="connected-memory-summary"><span class="connected-memory-count">' + countLabel + '</span>' + toggle + '</div>';
          if (!expanded || memories.length === 0) return summary;
          return summary + '<div class="connected-memory-window">' + memories.map((memory) =>
            '<button class="connected-memory-row" type="button" data-detail-node-id="' + escapeAttribute(memory.id) + '">' +
              '<span class="connected-memory-copy"><span class="connected-memory-title">' + escapeHtml(graftMemoryTitle(memory)) + '</span>' +
              '<span class="connected-memory-value">' + escapeHtml(memory.value || "No value recorded") + '</span></span>' +
              '<span class="connected-memory-chevron" aria-hidden="true">›</span></button>'
          ).join("") + '</div>';
        }

        function connectedTopicsMarkup(topics) {
          if (topics.length === 0) return '<p class="subtle">No topics are connected to this segment.</p>';
          return '<ul class="detail-list">' + topics.map((topic) =>
            '<li><button class="detail-link" type="button" data-detail-node-id="' + escapeAttribute(topic.id) + '">' +
              escapeHtml((topic.label || topic.id) + (topic.summary ? ": " + truncate(topic.summary, 80) : "")) +
            '</button></li>'
          ).join("") + '</ul>';
        }

        function memoryRelationshipsMarkup(memoryId) {
          const edges = (state.graph.memoryEdges || []).filter((edge) => edge.sourceId === memoryId || edge.targetId === memoryId);
          if (edges.length === 0) return '<p class="subtle">No related, conflict, or update edges.</p>';

          return '<ul class="detail-list">' + edges.map((edge) => {
            const outgoing = edge.sourceId === memoryId;
            const relatedId = outgoing ? edge.targetId : edge.sourceId;
            const related = (state.graph.memories || []).find((memory) => memory.id === relatedId);
            const direction = outgoing ? "outgoing" : "incoming";
            const label = related ? related.subject + " " + related.predicate + ": " + related.value : relatedId;
            return '<li><span class="badge">' + escapeHtml(edge.edgeType || "related") + '</span> ' +
              '<span class="subtle">' + direction + '</span> ' +
              '<button class="detail-link" type="button" data-detail-node-id="' + escapeAttribute(relatedId) + '">' + escapeHtml(label) + '</button></li>';
          }).join("") + '</ul>';
        }

        function memoryLifecycleFlags(memory) {
          const flags = [];
          if (memory.forgotten) flags.push("forgotten");
          if (memory.decayed) flags.push("decayed");
          if (memory.hasConflict) flags.push("conflicting");
          if (memory.supersededBy) flags.push("superseded");
          return flags.length > 0 ? flags : ["active"];
        }

        function detailSection(title, content) {
          return '<section class="detail-section"><h2 class="detail-section-title">' + escapeHtml(title) + '</h2>' + content + '</section>';
        }

        function detailTextRow(label, value) {
          return detailRow(label, escapeHtml(value));
        }

        function detailRow(label, value) {
          return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span><span class="detail-value">' + value + '</span></div>';
        }

        function tagsMarkup(tags) {
          if (!tags || tags.length === 0) return "None";
          return '<span class="tag-row">' + tags.map((tag) => '<span class="badge">' + escapeHtml(tag) + '</span>').join("") + '</span>';
        }

        function memoryLifecycle(memory) {
          if (memory.forgotten) return "forgotten";
          if (memory.decayed) return "decayed";
          if (memory.supersededBy) return "superseded";
          if (memory.hasConflict) return "conflicting";
          return "active";
        }

        function formatMessageRange(range) {
          return Array.isArray(range) ? range.join(" to ") : "Unknown";
        }

        function formatSegmentRange(segment) {
          if (segment.startIndex == null || segment.endIndex == null) return "Unknown";
          return String(segment.startIndex) + " to " + String(segment.endIndex);
        }

        function messageIndexFromId(id) {
          const match = String(id || "").match(/^message:(\\d+)$/);
          return match ? Number.parseInt(match[1], 10) : null;
        }

        function sessionBadges(session) {
          const labels = [];
          if (session.id && session.id.startsWith("fleet:")) labels.push("fleet");
          if (session.id && session.id.includes(":shared")) labels.push("shared");
          return labels;
        }

        function numberText(value) {
          return new Intl.NumberFormat().format(value || 0);
        }

        function formatDate(value) {
          if (!value) return "No activity";
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return "No activity";
          return date.toLocaleString();
        }

        function truncate(value, length) {
          const text = String(value || "");
          if (text.length <= length) return text;
          return text.slice(0, Math.max(0, length - 1)) + "...";
        }

        function escapeHtml(value) {
          return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function escapeAttribute(value) {
          return escapeHtml(value);
        }
      })();
    </script>
  </body>
</html>`;
}
