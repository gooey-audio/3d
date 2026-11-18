// Gives OpenCascade failures a message and a script line number.
//
// The kernel throws C++ exceptions as `WebAssembly.Exception`, which carries
// no JavaScript stack, so a failed `fillet` cannot be traced to the script
// line that asked for it. Every replicad method and exported function is
// wrapped so that a kernel exception is converted, at the call boundary, into
// a `KernelError` whose stack includes the user's frames.

export class KernelError extends Error {
  kind = "kernel";
  ocType: string;
  constructor(ocType: string, message: string) {
    super(`OpenCascade ${ocType}${message ? `: ${message}` : ""}`);
    this.name = "KernelError";
    this.ocType = ocType;
  }
}

// `WebAssembly.Exception` is missing from TypeScript's lib typings.
const WasmException: (abstract new (...args: any[]) => object) | undefined = (WebAssembly as any).Exception;
export const isWasmException = (err: unknown) => typeof WasmException === "function" && err instanceof WasmException;

export function kernelError(oc: any, err: unknown): unknown {
  if (!isWasmException(err)) return err;
  let type = "C++ exception";
  let message = "";
  try {
    [type, message] = oc.getExceptionMessage(err);
    oc.decrementExceptionRefcount?.(err);
  } catch {}
  return new KernelError(type, message);
}

const patched = new WeakSet<object>();

// Returns a copy of the replicad namespace for user scripts; also patches the
// prototypes of every replicad object a script can reach.
export function instrumentReplicad<T extends Record<string, any>>(replicad: T, oc: any): T {
  const wrap = (fn: Function) =>
    function (this: unknown, ...args: unknown[]) {
      let result;
      try {
        result = fn.apply(this, args);
      } catch (err) {
        throw kernelError(oc, err);
      }
      patchObject(result);
      return result;
    };

  // Patch the prototype chain of an object returned by replicad (covers
  // classes that are not exported, e.g. the pen returned by `draw()`).
  function patchObject(value: unknown) {
    if (!value || typeof value !== "object") return;
    // Raw OpenCascade (embind) handles must stay untouched: their methods
    // dispatch overloads through internals that a wrapper breaks.
    // (Every embind object inherits ClassHandle's `isAliasOf`.)
    if (typeof (value as any).isAliasOf === "function") return;
    if (Array.isArray(value)) {
      if (value.length) patchObject(value[0]);
      return;
    }
    for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      patchPrototype(proto);
    }
  }

  function patchPrototype(proto: any) {
    if (patched.has(proto)) return;
    patched.add(proto);
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, key)!;
      if (!d.configurable) continue;
      if (typeof d.value === "function") d.value = wrap(d.value);
      if (d.get) d.get = wrap(d.get);
      if (d.set) d.set = wrap(d.set);
      Object.defineProperty(proto, key, d);
    }
  }

  const api: Record<string, any> = {};
  for (const [name, value] of Object.entries(replicad)) {
    const isClass = typeof value === "function" && /^class\b/.test(Function.prototype.toString.call(value));
    if (isClass) {
      for (let p = value.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) patchPrototype(p);
      api[name] = value; // keep identity for `instanceof` and `new`
    } else if (typeof value === "function") {
      api[name] = wrap(value);
    } else {
      api[name] = value;
    }
  }
  return api as T;
}
