// Generated from the engine API schema; runtime validation additionally checks bounds.
export const BRIDGE_API_NAME: "toolsenabled.mission-bridge";
export const BRIDGE_API_MAJOR: number;
export const BRIDGE_API_MINOR: number;
export const BRIDGE_API_CONTRACT_SCHEMA: Readonly<Record<string, unknown>>;
export type BridgeApiContract = { readonly "schemaVersion": 1; readonly "api": { readonly "name": "toolsenabled.mission-bridge"; readonly "major": number; readonly "minor": number; }; readonly "actions": ReadonlyArray<string>; readonly "capabilityMeaning": "registered-not-authorized-or-ready"; readonly "automaticWriteRetry": "never"; };
export function createBridgeApiContract(routes: Record<string, string>): BridgeApiContract;
export function validateBridgeApiContract(value: unknown): value is BridgeApiContract;
export function assessBridgeApiCompatibility(value: unknown, options?: { requiredActions?: string[] }): { ok: true; apiMajor: number; apiMinor: number } | { ok: false; code: string; missingActions?: string[] };
