// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";

export const enum RefType {
  Head,
  RemoteHead,
  Tag
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface RepositoryState {
  readonly HEAD: Ref | undefined;
  readonly refs: Ref[];
  readonly remotes: Remote[];
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

interface GitAPI {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): Repository | null;
}

export let api: GitAPI;
export async function initializeGitApi() {
  const extension = vscode.extensions.getExtension("vscode.git");
  if (!extension) {
    return;
  }

  if (!extension.isActive) {
    await extension.activate();
  }

  api = extension.exports.getAPI(1);
}
