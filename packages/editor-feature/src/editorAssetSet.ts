export interface EditorAssetSetReadiness {
  directory: string | null;
  projectDirectory: string | null;
  assetLoading: boolean;
  hasMeta: boolean;
  initialized: boolean;
  error: string | null;
}

export function isEditorAssetSetReady(state: EditorAssetSetReadiness, directory: string): boolean {
  return state.directory === directory
    && state.projectDirectory === directory
    && !state.assetLoading
    && state.hasMeta
    && state.initialized
    && !state.error;
}
