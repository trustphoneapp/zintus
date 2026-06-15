declare module "tauri-pty" {
  export interface PtyProcess {
    onData(handler: (data: string) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  }

  export function spawn(
    file: string,
    args?: string[],
    options?: { cols?: number; rows?: number },
  ): PtyProcess;
}
