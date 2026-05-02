import { execFile } from 'node:child_process';

export function execFilePromise(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, env: { ...process.env, ...options.env } }, (err, stdout, stderr) => {
      if (err) {
        const stderrMsg = stderr?.trim() ? `\nstderr: ${stderr.trim()}` : '';
        reject(new Error(`${err.message}${stderrMsg}`));
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
}
