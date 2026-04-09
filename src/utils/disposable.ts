/** Polyfill Symbol.dispose if not available. */
if (typeof Symbol.dispose === 'undefined') {
  (Symbol as any).dispose = Symbol('Symbol.dispose');
}
