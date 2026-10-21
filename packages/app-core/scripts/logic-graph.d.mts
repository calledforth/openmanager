export declare const LOGIC_ENTRY: string
export declare const LOGIC_DOM_GLOBALS: readonly string[]
export declare const LOGIC_FORBIDDEN_PACKAGES: readonly string[]
export declare function walkLogicGraph(entry?: string): Map<string, string[]>
export declare function logicGraphFiles(root: string, entry?: string): string[]
