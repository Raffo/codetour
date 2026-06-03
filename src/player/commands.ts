// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { when } from "mobx";
import type { AxiosError, Method } from "axios";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { api } from "../git";
import { focusPlayer } from "../player";
import { saveTour } from "../recorder/commands";
import { CodeTour, store } from "../store";
import {
  endCurrentCodeTour,
  exportTour,
  moveCurrentCodeTourBackward,
  moveCurrentCodeTourForward,
  selectTour,
  startCodeTour
} from "../store/actions";
import { progress } from "../store/storage";
import { getStepLabel, readUriContents } from "../utils";
import { CodeTourNode } from "./tree/nodes";

let terminal: vscode.Terminal | null;

interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}

interface PullRequestFile {
  filename: string;
  patch?: string;
}

interface PullRequest {
  number: number;
  html_url: string;
}

interface GitHubRepository {
  owner: string;
  repo: string;
}

interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

interface SkippedReviewStep {
  stepNumber: number;
  reason: string;
}

interface GitHubErrorResponse {
  message?: string;
  errors?: Array<{
    code?: string;
    field?: string;
    message?: string;
    resource?: string;
  }>;
}

function isGitHubAxiosError(
  error: unknown
): error is AxiosError<GitHubErrorResponse> {
  return typeof error === "object" && error !== null && "response" in error;
}

function getGitHubErrorMessage(error: unknown) {
  if (isGitHubAxiosError(error)) {
    const data = error.response?.data;
    if (data) {
      const details = data.errors
        ?.map(detail =>
          [detail.resource, detail.field, detail.code, detail.message]
            .filter(Boolean)
            .join(" ")
        )
        .filter(Boolean)
        .join("; ");

      return details && data.message
        ? `${data.message}: ${details}`
        : data.message || details || error.message;
    }

    return error.message;
  }

  return String(error);
}

function parsePullRequestInput(input: string): PullRequestTarget | undefined {
  const value = input.trim();
  const urlMatch = value.match(
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\/?$/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      pullNumber: Number(urlMatch[3])
    };
  }

  const shorthandMatch = value.match(/^([^\/\s]+)\/([^#\/\s]+)(?:#|\/pull\/)(\d+)$/);
  if (shorthandMatch) {
    return {
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
      pullNumber: Number(shorthandMatch[3])
    };
  }
}

function formatPullRequestTarget(target: PullRequestTarget) {
  return `${target.owner}/${target.repo}#${target.pullNumber}`;
}

function parseGitHubRemoteUrl(url?: string): GitHubRepository | undefined {
  if (!url) {
    return;
  }

  const match = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\/]+)\/(.+?)(?:\.git)?$/
  );
  if (!match) {
    return;
  }

  return {
    owner: match[1],
    repo: match[2]
  };
}

function getUniqueRepositories(repositories: GitHubRepository[]) {
  const seen = new Set<string>();
  return repositories.filter(repository => {
    const key = `${repository.owner}/${repository.repo}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getRepositoryForTour(tour: CodeTour) {
  if (!api) {
    return;
  }

  const tourUri = vscode.Uri.parse(tour.id);
  const workspaceRoot =
    vscode.workspace.getWorkspaceFolder(tourUri)?.uri ||
    vscode.workspace.workspaceFolders?.[0]?.uri;

  return workspaceRoot ? api.getRepository(workspaceRoot) : undefined;
}

async function findPullRequestsForBranch(
  base: GitHubRepository,
  head: GitHubRepository,
  branch: string,
  token: string
) {
  const pulls = await githubRequest<PullRequest[]>(
    "GET",
    `https://api.github.com/repos/${base.owner}/${base.repo}/pulls?state=open&head=${encodeURIComponent(
      `${head.owner}:${branch}`
    )}`,
    token
  );

  return pulls.map(pull => ({
    owner: base.owner,
    repo: base.repo,
    pullNumber: pull.number
  }));
}

async function detectPullRequestForTour(
  tour: CodeTour,
  token: string
): Promise<PullRequestTarget | undefined> {
  const repository = getRepositoryForTour(tour);
  const branch = repository?.state.HEAD?.name;
  if (!repository || !branch) {
    return;
  }

  const gitHubRepositories = getUniqueRepositories(
    repository.state.remotes.flatMap(remote =>
      [
        parseGitHubRemoteUrl(remote.pushUrl),
        parseGitHubRemoteUrl(remote.fetchUrl)
      ].filter((repo): repo is GitHubRepository => !!repo)
    )
  );

  if (gitHubRepositories.length === 0) {
    return;
  }

  const targets: PullRequestTarget[] = [];
  for (const base of gitHubRepositories) {
    for (const head of gitHubRepositories) {
      try {
        targets.push(
          ...(await findPullRequestsForBranch(base, head, branch, token))
        );
      } catch {
        // Ignore inaccessible remotes during best-effort detection.
      }
    }
  }

  const uniqueTargets = targets.filter(
    (target, index) =>
      targets.findIndex(
        item =>
          item.owner === target.owner &&
          item.repo === target.repo &&
          item.pullNumber === target.pullNumber
      ) === index
  );

  if (uniqueTargets.length === 1) {
    return uniqueTargets[0];
  } else if (uniqueTargets.length > 1) {
    const response = await vscode.window.showQuickPick(
      uniqueTargets.map(target => ({
        label: formatPullRequestTarget(target),
        target
      })),
      { placeHolder: "Select the pull request to review" }
    );

    return response?.target;
  }
}

function getReviewLineNumbers(patch?: string): Set<number> {
  const lines = new Set<number>();
  if (!patch) {
    return lines;
  }

  let newLine: number | undefined;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (typeof newLine === "undefined" || line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.add(newLine++);
    } else if (line.startsWith(" ")) {
      lines.add(newLine++);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
  }

  return lines;
}

function getStepReviewLine(step: CodeTour["steps"][number]): number | undefined {
  return step.selection?.end.line || step.line;
}

function buildReviewDraft(tour: CodeTour, files: PullRequestFile[]) {
  const changedLinesByFile = new Map(
    files.map(file => [file.filename, getReviewLineNumbers(file.patch)])
  );

  const comments: ReviewComment[] = [];
  const skipped: SkippedReviewStep[] = [];

  tour.steps.forEach((step, index) => {
    const body = step.description.trim();
    if (!body) {
      skipped.push({
        stepNumber: index + 1,
        reason: "step description is empty"
      });
      return;
    }

    if (!step.file) {
      skipped.push({
        stepNumber: index + 1,
        reason: "step is not associated with a file"
      });
      return;
    }

    const line = getStepReviewLine(step);
    if (!line) {
      skipped.push({
        stepNumber: index + 1,
        reason: "step does not have a line or selection"
      });
      return;
    }

    const changedLines = changedLinesByFile.get(step.file);
    if (!changedLines) {
      skipped.push({
        stepNumber: index + 1,
        reason: `${step.file} is not in the PR diff`
      });
      return;
    }

    if (!changedLines.has(line)) {
      skipped.push({
        stepNumber: index + 1,
        reason: `${step.file}:${line} is not commentable in the PR diff`
      });
      return;
    }

    comments.push({
      path: step.file,
      line,
      side: "RIGHT",
      body
    });
  });

  return { comments, skipped };
}

function buildReviewBody() {
  return "Posting a self code review generated from AI automation.";
}

async function getGitHubSession() {
  try {
    return await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: true
    });
  } catch {
    vscode.window.showErrorMessage(
      "Sign in to GitHub before submitting a CodeTour as a PR review."
    );
  }
}

async function githubRequest<T>(
  method: Method,
  url: string,
  token: string,
  data?: unknown
): Promise<T> {
  const axios = await import("axios");
  const response = await axios.default.request<unknown>({
    method,
    url,
    data,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  return response.data as T;
}

async function getPullRequestFiles(
  target: PullRequestTarget,
  token: string
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;

  while (true) {
    const pageFiles = await githubRequest<PullRequestFile[]>(
      "GET",
      `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}/files?per_page=100&page=${page}`,
      token
    );

    files.push(...pageFiles);

    if (pageFiles.length < 100) {
      return files;
    }

    page++;
  }
}

export function registerPlayerCommands() {
  // This is a "private" command that's used exclusively
  // by the hover description for tour markers.
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}._startTourById`,
    async (id: string, stepNumber: number) => {
      const tour = store.tours.find(tour => tour.id === id);
      if (tour) {
        startCodeTour(tour, stepNumber);
      }
    }
  );

  // Purpose: Command link
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.startTourByTitle`,
    async (title: string, stepNumber?: number) => {
      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => tour.title === title);
      if (tour) {
        startCodeTour(
          tour,
          stepNumber && --stepNumber,
          store.activeTour?.workspaceRoot,
          undefined,
          undefined,
          store.activeTour?.tours
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.finishTour`,
    async (title?: string) => {
      await progress.update();

      if (title) {
        vscode.commands.executeCommand(
          `${EXTENSION_NAME}.startTourByTitle`,
          title
        );
      } else {
        vscode.commands.executeCommand(`${EXTENSION_NAME}.endTour`);
      }
    }
  );

  // Purpose: Command link
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.navigateToStep`,
    async (stepNumber: number) => {
      startCodeTour(
        store.activeTour!.tour,
        --stepNumber,
        store.activeTour?.workspaceRoot,
        undefined,
        undefined,
        store.activeTour?.tours
      );
    }
  );

  // Purpose: Command link and the ">>" syntax
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.sendTextToTerminal`,
    async (text: string) => {
      if (!terminal) {
        terminal = vscode.window.createTerminal("CodeTour");
        vscode.window.onDidCloseTerminal(term => {
          if (term.name === "CodeTour") {
            terminal = null;
          }
        });

        when(
          () => store.activeTour === null,
          () => terminal?.dispose()
        );
      }

      terminal.show();
      terminal.sendText(text, true);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.insertCodeSnippet`,
    async (codeBlock: string) => {
      const codeSnippet = decodeURIComponent(codeBlock);

      const step = store.activeTour!.tour.steps[store.activeTour!.step];
      if (step.selection) {
        await vscode.window.activeTextEditor?.edit(e => {
          const selection = new vscode.Selection(
            step.selection!.start.line - 1,
            step.selection!.start.character - 1,
            step.selection!.end.line - 1,
            step.selection!.end.character - 1
          );
          e.replace(selection, codeSnippet);
        });
      } else {
        const position = new vscode.Position(step.line! - 1, 0);
        await vscode.window.activeTextEditor?.edit(e =>
          e.insert(position, codeSnippet)
        );
      }

      const lineAdjustment = codeSnippet.split("\n").length - 1;
      if (lineAdjustment > 0) {
        store.activeTour!.tour.steps[
          store.activeTour!.step
        ].line! += lineAdjustment;

        saveTour(store.activeTour!.tour);
      }

      await vscode.commands.executeCommand("editor.action.formatDocument");
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.startTour`,
    async (
      tour?: CodeTour | CodeTourNode,
      stepNumber?: number,
      workspaceRoot?: vscode.Uri,
      tours?: CodeTour[]
    ) => {
      if (tour) {
        const targetTour = tour instanceof CodeTourNode ? tour.tour : tour;
        return startCodeTour(
          targetTour,
          stepNumber,
          workspaceRoot,
          undefined,
          undefined,
          tours
        );
      }

      selectTour(store.tours, workspaceRoot);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.viewNotebook`,
    async (node: CodeTourNode) => {
      const tourUri = vscode.Uri.parse(node.tour.id);
      vscode.window.showTextDocument(tourUri);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.endTour`,
    endCurrentCodeTour
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.previousTourStep`,
    moveCurrentCodeTourBackward
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.nextTourStep`,
    moveCurrentCodeTourForward
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.resumeTour`, focusPlayer);

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.sendStepCommentToCopilot`,
    async (reply?: vscode.CommentReply) => {
      const availableCommands = await vscode.commands.getCommands(true);
      if (!availableCommands.includes("workbench.action.chat.open")) {
        return vscode.window.showErrorMessage(
          "Copilot Chat isn't available in this VS Code window."
        );
      }

      if (!store.activeTour) {
        return vscode.window.showErrorMessage(
          "Start a CodeTour step before sending a comment to Copilot Chat."
        );
      }

      const comment = reply?.text.trim();
      if (!comment) {
        return vscode.window.showErrorMessage(
          "Enter a comment before sending it to Copilot Chat."
        );
      }

      const tour = store.activeTour.tour;
      const targetStepNumber = store.activeTour.step;
      const step = tour.steps[targetStepNumber];
      const stepLabel = getStepLabel(tour, targetStepNumber);
      const location = [
        step.file ? `File: ${step.file}` : undefined,
        step.directory ? `Directory: ${step.directory}` : undefined,
        step.uri ? `URI: ${step.uri}` : undefined,
        step.view ? `View: ${step.view}` : undefined,
        step.line ? `Line: ${step.line}` : undefined
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = `A reviewer left this comment while reviewing a CodeTour step.

If the comment asks a question or requests clarification, answer it without making code or tour-file changes.
Only make edits when the comment clearly asks you to change code, documentation, or the tour.

Tour: ${tour.title}
Step: ${targetStepNumber + 1} of ${tour.steps.length}
Step label: ${stepLabel}
${location ? `${location}\n` : ""}
Step description:
${step.description}

Comment:
${comment}`;

      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: prompt,
        isPartialQuery: false
      });
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.openTourFile`,
    async () => {
      const uri = await vscode.window.showOpenDialog({
        filters: {
          Tours: ["tour"]
        },
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Open Tour"
      });

      if (!uri) {
        return;
      }

      try {
        const contents = await readUriContents(uri[0]);

        const tour = JSON.parse(contents);
        tour.id = decodeURIComponent(uri[0].toString());

        startCodeTour(tour);
      } catch {
        vscode.window.showErrorMessage(
          "This file doesn't appear to be a valid tour. Please inspect its contents and try again."
        );
      }
    }
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.openTourUrl`, async () => {
    const url = await vscode.window.showInputBox({
      prompt: "Specify the URL of the tour file to open",
      value: await vscode.env.clipboard.readText()
    });

    if (!url) {
      return;
    }

    try {
      const axios = await import("axios");
      const response = await axios.default.get<CodeTour>(url);
      const tour = response.data;
      tour.id = url;
      startCodeTour(tour);
    } catch {
      vscode.window.showErrorMessage(
        "This file doesn't appear to be a valid tour. Please inspect its contents and try again."
      );
    }
  });

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.exportTour`,
    async (node: CodeTourNode) => {
      const uri = await vscode.window.showSaveDialog({
        filters: {
          Tours: ["tour"]
        },
        saveLabel: "Export Tour"
      });

      if (!uri) {
        return;
      }

      const contents = await exportTour(node.tour);
      const bytes = new TextEncoder().encode(contents);
      vscode.workspace.fs.writeFile(uri, bytes);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.submitTourAsPrReview`,
    async (node?: CodeTourNode) => {
      const tour = node?.tour || store.activeTour?.tour;
      if (!tour) {
        return vscode.window.showErrorMessage(
          "Select or start a CodeTour before submitting it as a PR review."
        );
      }

      const session = await getGitHubSession();
      if (!session) {
        return;
      }

      let target = await detectPullRequestForTour(tour, session.accessToken);
      if (!target) {
        const clipboard = await vscode.env.clipboard.readText();
        const input = await vscode.window.showInputBox({
          prompt: "Enter the target PR URL or owner/repo#number",
          placeHolder: "https://github.com/owner/repo/pull/123",
          value: parsePullRequestInput(clipboard) ? clipboard : ""
        });
        if (!input) {
          return;
        }

        target = parsePullRequestInput(input);
        if (!target) {
          return vscode.window.showErrorMessage(
            "Enter a GitHub PR as a URL or in owner/repo#number format."
          );
        }
      } else {
        vscode.window.showInformationMessage(
          `Detected PR ${formatPullRequestTarget(target)} for the current branch.`
        );
      }

      let files: PullRequestFile[];
      try {
        files = await getPullRequestFiles(target, session.accessToken);
      } catch (e) {
        return vscode.window.showErrorMessage(
          `Unable to read PR #${target.pullNumber}: ${getGitHubErrorMessage(e)}`
        );
      }

      const { comments, skipped } = buildReviewDraft(tour, files);
      if (comments.length === 0 && skipped.length === 0) {
        return vscode.window.showErrorMessage(
          "This tour doesn't contain any steps to submit."
        );
      }

      const confirmation = await vscode.window.showInformationMessage(
        `Submit "${tour.title}" as a review on ${target.owner}/${target.repo}#${target.pullNumber}? ${comments.length} inline comment(s), ${skipped.length} skipped step(s).`,
        { modal: true },
        "Submit Review"
      );
      if (confirmation !== "Submit Review") {
        return;
      }

      try {
        await githubRequest(
          "POST",
          `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}/reviews`,
          session.accessToken,
          {
            event: "COMMENT",
            body: buildReviewBody(),
            comments
          }
        );

        vscode.window.showInformationMessage(
          `Submitted CodeTour review to ${target.owner}/${target.repo}#${target.pullNumber}.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Unable to submit PR review: ${getGitHubErrorMessage(e)}`
        );
      }
    }
  );

  function setShowMarkers(showMarkers: boolean) {
    store.showMarkers = showMarkers;

    vscode.workspace
      .getConfiguration("codetour")
      .update("showMarkers", showMarkers, vscode.ConfigurationTarget.Global);

    vscode.commands.executeCommand(
      "setContext",
      "codetour:showingMarkers",
      showMarkers
    );
  }

  vscode.commands.registerCommand(`${EXTENSION_NAME}.hideMarkers`, () =>
    setShowMarkers(false)
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.showMarkers`, () =>
    setShowMarkers(true)
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.resetProgress`, () =>
    progress.reset()
  );
}
