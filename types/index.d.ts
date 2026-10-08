// when helmd last answered the fleet; a drawing that reads it is drawn again on the next answer
export type HelmStamp = number;

// the pane's open tab
export type HelmTab = 'work' | 'epics' | 'ci' | 'inbox';

declare module 'claude-code' {
  interface PluginState {
    helm: { fleetAt: HelmStamp; paneTab: HelmTab };
  }
}
