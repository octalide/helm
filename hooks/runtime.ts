import { isRepoName } from '../src/core/repo.ts';
import type { RepoName, SessionRole } from '../src/core/types.ts';
import { type HelmClient, HelmError } from '../src/mod/client.ts';
import type { Install } from '../src/mod/install.ts';
import type { Mailbox } from '../src/mod/mailbox.ts';
import type { ToolEnv } from '../src/mod/tools.ts';

export const PLUGIN = 'helm';

export const ROLES: readonly SessionRole[] = ['coordinator', 'repo', 'other'];

// one session's binding to helmd, for one load of the module: a reload starts a new one and the old one's loops stop.
// everything that reaches the engine lives in helm.tsx, since the engine follows $ into no other file; what is here
// and under src/mod is plain logic over the ports helm.tsx builds
export type Runtime = {
  client: HelmClient;
  version: string;
  // this mod's own install, beside which the newest helmd is looked for
  install: Install;
  home: string;
  session: string;
  // the session's repository and role as helmd last answered them
  repo?: RepoName;
  role: SessionRole;
  // the role asked for, by HELM_ROLE or /helm role, sent at each register; without one helmd decides
  asked?: SessionRole;
  // the repository of the checkout the session runs in, a default for a session helmd does not know
  checkout?: RepoName;
  mailbox: Mailbox;
  // the web page helmd serves, once it has answered
  web?: string;
  // this load of the module, stamped as the binding's holder; alive goes false for good once another holds it
  instance: string;
  alive: boolean;
  timers: { cancel: () => void }[];
};

export function toolEnv(r: Runtime): ToolEnv {
  return {
    client: r.client,
    session: () => r.session,
    home: r.home,
    now: Date.now,
    version: r.version,
    pending: () => r.mailbox.pending(),
    repo: (given) => {
      if (isRepoName(given)) return given;
      if (given !== undefined && given !== '') throw new HelmError(400, `repo ${String(given)} is not owner/name`);
      if (!r.repo) throw new HelmError(400, 'this session has no repository: pass repo as owner/name');
      return r.repo;
    },
  };
}
