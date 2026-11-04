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
  export interface WindowFrame {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface Display {
    id: number;
    bounds: WindowFrame;
    workArea: WindowFrame;
    scaleFactor: number;
    isPrimary: boolean;
  }

  export const ApplicationMenu: {
    setApplicationMenu(items: unknown[]): void;
  };

  export const Screen: {
    getAllDisplays(): Display[];
    getPrimaryDisplay(): Display;
  };

  export class BrowserWindow {
    readonly id: number | string;
    constructor(options: {
      title: string;
      url: string;
      frame?: { x?: number; y?: number; width: number; height: number };
    });
    activate(): void;
    isMinimized(): boolean;
    isMaximized(): boolean;
    maximize(): void;
    getFrame(): WindowFrame;
    setSize(width: number, height: number): void;
    on(name: string, handler: (event: { data: unknown }) => void): void;
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
