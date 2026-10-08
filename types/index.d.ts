// when helmd last answered the fleet; a drawing that reads it is drawn again on the next answer
export type HelmStamp = number;

declare module 'claude-code' {
  interface PluginState {
    helm: { fleetAt: HelmStamp };
  }
}
