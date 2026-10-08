import type { RepoName } from './types.ts';

// owner/name of a github remote url in any of its spellings
export function repoOfRemote(url: string): RepoName | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function isRepoName(v: unknown): v is RepoName {
  return typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v);
}

// a strict semver comparison of x.y.z, prerelease ignored; negative when a is older
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
