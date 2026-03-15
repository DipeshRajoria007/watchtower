import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { DiffViewer } from "../components/DiffViewer";
import { EmptyState, PageIntro, SectionCard } from "../components/primitives";
import type { JobDiff, CreatePrResponse } from "../types";

type ReviewPageProps = {
  jobId: string;
  onBack: () => void;
};

export function ReviewPage({ jobId, onBack }: ReviewPageProps) {
  const [diff, setDiff] = useState<JobDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [creatingPr, setCreatingPr] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadDiff = async () => {
      try {
        const result = await invoke<JobDiff | null>("get_job_diff", { jobId });
        if (active) {
          setDiff(result);
          if (result) {
            setPrTitle(`miniOG: ${result.branchName.replace("miniog/", "")}`);
          }
        }
      } catch (err) {
        if (active) {
          toast.error("Failed to load diff", { description: String(err) });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadDiff();
    return () => {
      active = false;
    };
  }, [jobId]);

  const handleCreatePr = async () => {
    if (!diff || !prTitle.trim()) return;

    setCreatingPr(true);
    try {
      const result = await invoke<CreatePrResponse>("create_pr_from_job", {
        jobId,
        title: prTitle,
        body: prBody,
      });
      setPrUrl(result.prUrl);
      toast.success("Pull request created", {
        description: result.prUrl,
      });
    } catch (err) {
      toast.error("Failed to create PR", { description: String(err) });
    } finally {
      setCreatingPr(false);
    }
  };

  const repoName = diff?.repoPath.split("/").pop() ?? "";
  const compareUrl = diff
    ? `https://github.com/Newton-School/${repoName}/compare/main...${diff.branchName}`
    : "";

  if (loading) {
    return (
      <div className="page-stack">
        <PageIntro
          eyebrow="PM Workflow"
          title="Review Changes"
          description="Loading diff data for this job."
        />
        <SectionCard title="Loading" subtitle="Fetching diff from database.">
          <EmptyState>Loading diff...</EmptyState>
        </SectionCard>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="page-stack">
        <PageIntro
          eyebrow="PM Workflow"
          title="Review Changes"
          description="No diff data was found for this job."
          actions={
            <button className="ghost-button" type="button" onClick={onBack}>
              Back to Runs
            </button>
          }
        />
        <SectionCard title="No Diff Found" subtitle="This job may not have produced code changes.">
          <EmptyState>No diff data available for job {jobId}.</EmptyState>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="page-stack review-page">
      <PageIntro
        eyebrow="PM Workflow"
        title="Review Changes"
        description={`Branch: ${diff.branchName} | Repo: ${repoName} | +${diff.insertions} -${diff.deletions} | ${diff.files.length} files`}
        actions={
          <button className="ghost-button" type="button" onClick={onBack}>
            Back to Runs
          </button>
        }
      />

      <SectionCard
        title="Diff Viewer"
        subtitle={`Showing changes on ${diff.branchName}`}
        count={diff.files.length}
      >
        <DiffViewer
          branchName={diff.branchName}
          diffText={diff.diffText}
          files={diff.files}
          insertions={diff.insertions}
          deletions={diff.deletions}
        />
      </SectionCard>

      <SectionCard
        title="Actions"
        subtitle="Review the changes above, then create a PR or view on GitHub."
      >
        <div className="review-actions">
          <div className="review-actions-row">
            <a
              className="ghost-button"
              href={compareUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on GitHub
            </a>
          </div>

          {prUrl ? (
            <div className="review-pr-success">
              <strong>PR created successfully:</strong>
              <a href={prUrl} target="_blank" rel="noopener noreferrer">
                {prUrl}
              </a>
            </div>
          ) : (
            <div className="review-pr-form">
              <label className="field">
                <span>PR Title</span>
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  placeholder="PR title"
                />
              </label>
              <label className="field">
                <span>PR Body</span>
                <textarea
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  placeholder="Describe the changes..."
                  rows={4}
                />
              </label>
              <button
                className="primary-button"
                type="button"
                onClick={handleCreatePr}
                disabled={creatingPr || !prTitle.trim()}
              >
                {creatingPr ? "Creating PR..." : "Create Pull Request"}
              </button>
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
