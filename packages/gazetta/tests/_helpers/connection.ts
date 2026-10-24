/**
 * The env `@hono/node-server` passes to the app: the request's socket,
 * as `env.incoming`. Pass it as `app.request()`'s third argument to send
 * a request on a connection from `remoteAddress`.
 */
export function fromConnection(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } }
}
