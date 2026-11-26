/** node:os for the Worker build: only what the shared code touches, and never a real home folder. */
export const homedir = (): string => '/';
export const tmpdir = (): string => '/tmp';
export const platform = (): string => 'linux';
export const EOL = '\n';
export default { homedir, tmpdir, platform, EOL };
