declare module "electrobun" {
  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
      description?: string;
    };
    build: {
      mainProcess: "bun";
      bun: { entrypoint: string };
      copy?: Record<string, string>;
    };
    runtime?: { exitOnLastWindowClosed?: boolean };
  }
}

declare module "electrobun/main" {
  export const ApplicationMenu: {
    setApplicationMenu(items: unknown[]): void;
  };

  export class BrowserWindow {
    readonly id: number | string;
    constructor(options: {
      title: string;
      url: string;
      frame?: { width: number; height: number };
    });
    activate(): void;
    isMinimized(): boolean;
    show(): void;
    unminimize(): void;
  }

  export const Utils: {
    paths: { appData: string; home: string };
    openFileDialog(options: {
      startingFolder?: string;
      allowedFileTypes?: string;
      canChooseFiles: boolean;
      canChooseDirectory: boolean;
      allowsMultipleSelection: boolean;
    }): Promise<string[]>;
  };
}
