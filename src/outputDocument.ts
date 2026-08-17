import * as vscode from "vscode";

export const HERDR_OUTPUT_SCHEME = "herdr-output";

/** Provides a read-only, copyable editor for a pane's recent output. */
export class HerdrOutputDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    const key = uri.toString();
    if (this.contents.get(key) === content) {
      return;
    }
    this.contents.set(key, content);
    this.changeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.contents.clear();
    this.changeEmitter.dispose();
  }
}

export function outputDocumentUri(paneId: string): vscode.Uri {
  const fileName = paneId.replace(/[^a-zA-Z0-9._-]+/g, "-") || "agent";
  return vscode.Uri.from({
    scheme: HERDR_OUTPUT_SCHEME,
    path: `/herdr-${fileName}.txt`,
  });
}
