/* tslint:disable */
/* eslint-disable */

export class ColdClear {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `cols`: 10 column bitboards (bit y set => filled at row y, y up).
     * `queue`: upcoming pieces as letters, front = current piece.
     * `hold`: single hold-piece letter, or "" for empty.
     */
    constructor(cols: Uint32Array, queue: string, hold: string, back_to_back: boolean, combo: number);
    /**
     * Ranked moves (best first) as a JSON array, or null if none. Each item:
     * piece, spin ('n'|'m'|'f'), lines, usesHold, soft (needs a soft-drop /
     * tuck — a more cognitively demanding placement), cells (8 ints), x, y.
     */
    suggest(): string | undefined;
    /**
     * Run `iters` units of search work (grows the tree).
     */
    work(iters: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_coldclear_free: (a: number, b: number) => void;
    readonly coldclear_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly coldclear_suggest: (a: number) => [number, number];
    readonly coldclear_work: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
