import { useMemo, useState } from "react";
import type { DiffFileEntry } from "../types";
import { StatusBadge } from "./primitives";

type DiffViewerProps = {
  branchName: string;
  diffText: string;
  files: DiffFileEntry[];
  insertions: number;
  deletions: number;
};

type ParsedHunk = {
  filePath: string;
  header: string;
  lines: string[];
};

function parseDiffIntoHunks(diffText: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = diffText.split("\n");
  let currentFile = "";
  let currentHeader = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        hunks.push({
          filePath: currentFile,
          header: currentHeader,
          lines: currentLines,
        });
      }
      const match = line.match(/b\/(.+)$/);
      currentFile = match?.[1] ?? line;
      currentHeader = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentFile) {
    hunks.push({
      filePath: currentFile,
      header: currentHeader,
      lines: currentLines,
    });
  }

  return hunks;
}

function statusColor(
  status: DiffFileEntry["status"],
): "success" | "warn" | "danger" {
  switch (status) {
    case "added":
      return "success";
    case "deleted":
      return "danger";
    default:
      return "warn";
  }
}

export function DiffViewer({
  branchName,
  diffText,
  files,
  insertions,
  deletions,
}: DiffViewerProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    files[0]?.path ?? null,
  );
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");

  const hunks = useMemo(() => parseDiffIntoHunks(diffText), [diffText]);

  const selectedHunk = useMemo(() => {
    if (!selectedFile) return null;
    return hunks.find((h) => h.filePath === selectedFile) ?? null;
  }, [hunks, selectedFile]);

  return (
    <div className="diff-viewer">
      <div className="diff-summary-bar">
        <div className="diff-summary-stats">
          <span className="diff-branch">{branchName}</span>
          <span className="diff-stat-files">{files.length} files</span>
          <span className="diff-stat-add">+{insertions}</span>
          <span className="diff-stat-del">-{deletions}</span>
        </div>
        <div className="diff-view-toggle" role="group">
          <button
            className={viewMode === "unified" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("unified")}
          >
            Unified
          </button>
          <button
            className={viewMode === "split" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("split")}
          >
            Split
          </button>
        </div>
      </div>

      <div className="diff-body">
        <div className="diff-file-sidebar">
          <ul>
            {files.map((file) => (
              <li key={file.path}>
                <button
                  className={
                    file.path === selectedFile
                      ? "diff-file-item selected"
                      : "diff-file-item"
                  }
                  type="button"
                  onClick={() => setSelectedFile(file.path)}
                >
                  <StatusBadge
                    label={file.status[0].toUpperCase()}
                    tone={statusColor(file.status)}
                  />
                  <span className="diff-file-path">{file.path}</span>
                  <span className="diff-file-stats">
                    <span className="diff-stat-add">+{file.insertions}</span>
                    <span className="diff-stat-del">-{file.deletions}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="diff-file-content">
          {selectedHunk ? (
            <pre className="diff-hunk-pre">
              <code>
                {selectedHunk.lines.map((line, i) => {
                  let lineClass = "diff-line";
                  if (line.startsWith("+") && !line.startsWith("+++"))
                    lineClass = "diff-line diff-add";
                  else if (line.startsWith("-") && !line.startsWith("---"))
                    lineClass = "diff-line diff-del";
                  else if (line.startsWith("@@"))
                    lineClass = "diff-line diff-hunk-header";

                  return (
                    <div key={i} className={lineClass}>
                      {line}
                    </div>
                  );
                })}
              </code>
            </pre>
          ) : (
            <p className="empty-state">Select a file to view its diff.</p>
          )}
        </div>
      </div>
    </div>
  );
}
